// lib/email.js
// Microsoft Graph API wrapper for transactional emails.
//
// Required env vars (Vercel dashboard):
//   MS_TENANT_ID     – Azure AD tenant ID
//   MS_CLIENT_ID     – App registration client ID
//   MS_CLIENT_SECRET – App registration client secret
//   MS_SENDER_EMAIL  – Shared mailbox / UPN to send from
//                      (app needs Mail.Send permission in Azure AD)
//
// If MS_TENANT_ID is not set, emails are only logged to console (dev mode).

import { getDealerInfo } from './dealers.js'

// ─────────────────────────────────────────────────────────────────────────────
// MS Graph OAuth2 (client credentials)
// ─────────────────────────────────────────────────────────────────────────────

async function getAccessToken() {
  const { MS_TENANT_ID: tenantId, MS_CLIENT_ID: clientId, MS_CLIENT_SECRET: clientSecret } = process.env
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('MS Graph env vars not configured (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET)')
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`
  console.log(`[email/token] POST ${tokenUrl}`)
  console.log(`[email/token] client_id=${clientId} secret_length=${clientSecret.length}`)

  const resp = await fetch(tokenUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
      scope:         'https://graph.microsoft.com/.default',
    }).toString(),
  })

  const rawBody = await resp.text()
  console.log(`[email/token] status=${resp.status} body=${rawBody.slice(0, 500)}`)

  if (!resp.ok) {
    throw new Error(`MS Graph token error ${resp.status}: ${rawBody}`)
  }

  const data = JSON.parse(rawBody)
  console.log(`[email/token] token_type=${data.token_type} expires_in=${data.expires_in} scope=${data.scope}`)
  return data.access_token
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a transactional email via Microsoft Graph API.
 * Falls back to console.log when MS_TENANT_ID is not set (dev / CI).
 *
 * @param {{ to: string, subject: string, html: string, text?: string }} opts
 */
export async function sendEmail({ to, subject, html, text, replyTo }) {
  const senderEmail = process.env.MS_SENDER_EMAIL

  // ── 1. Log env var presence (never log actual secret values) ─────────────
  console.log('[email] sendEmail called')
  console.log(`[email] env check: MS_TENANT_ID=${process.env.MS_TENANT_ID ? '✓ set' : '✗ MISSING'}`)
  console.log(`[email] env check: MS_CLIENT_ID=${process.env.MS_CLIENT_ID ? '✓ set' : '✗ MISSING'}`)
  console.log(`[email] env check: MS_CLIENT_SECRET=${process.env.MS_CLIENT_SECRET ? '✓ set' : '✗ MISSING'}`)
  console.log(`[email] env check: MS_SENDER_EMAIL=${senderEmail || '✗ MISSING'}`)
  console.log(`[email] to="${to}" subject="${subject}"`)

  // ── 2. Dev / no-config fallback ───────────────────────────────────────────
  if (!process.env.MS_TENANT_ID || !senderEmail) {
    console.log('[email] MS Graph not configured – logging email to console instead')
    if (text) console.log(`[email] body preview: ${text.slice(0, 200)}`)
    return { messageId: 'console-only' }
  }

  // ── 3. Get OAuth token ────────────────────────────────────────────────────
  let accessToken
  try {
    accessToken = await getAccessToken()
    console.log('[email] Access token obtained successfully')
  } catch (err) {
    console.error('[email] Failed to obtain MS Graph access token:', err.message)
    throw err
  }

  // ── 4. Call sendMail ──────────────────────────────────────────────────────
  const sendMailUrl = `https://graph.microsoft.com/v1.0/users/${senderEmail}/sendMail`
  console.log(`[email/sendMail] POST ${sendMailUrl}`)

  const resp = await fetch(sendMailUrl, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      message: {
        subject,
        body:         { contentType: 'HTML', content: html },
        toRecipients: [{ emailAddress: { address: to } }],
        ...(replyTo ? { replyTo: [{ emailAddress: { address: replyTo } }] } : {}),
      },
      saveToSentItems: true,
    }),
  })

  // Graph sendMail returns 202 Accepted on success (empty body)
  const respBody = await resp.text()
  console.log(`[email/sendMail] status=${resp.status} body=${respBody.slice(0, 500) || '(empty — expected on success)'}`)

  if (!resp.ok) {
    const err = new Error(`MS Graph sendMail error ${resp.status}: ${respBody}`)
    console.error('[email] sendMail failed:', err.message)
    throw err
  }

  const msgId = `graph-${Date.now()}`
  console.log(`[email] ✓ Sent "${subject}" → ${to} (${msgId})`)
  return { messageId: msgId }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared template helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Base email wrapper.
 * @param {string}      bodyHtml
 * @param {string|null} dealerLogoUrl  – optional dealer logo shown right-aligned in header
 */
const emailShell = (bodyHtml, dealerLogoUrl = null) => `<!DOCTYPE html>
<html lang="da">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;background:#F5F5F6;margin:0;padding:32px 16px">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #E0E0E4">
  <!-- Logo bar: CEPELO left + optional dealer logo right -->
  <div style="background:#fff;padding:20px 32px;border-bottom:1px solid #E0E0E4;display:flex;align-items:center;justify-content:space-between">
    <img src="https://cepelo.dk/cdn/shop/files/Cepelo-blaa-uden-tools.webp"
         alt="CEPELO" width="140"
         style="display:block;height:auto;border:0" />
    ${dealerLogoUrl
      ? `<img src="${dealerLogoUrl}" alt="" width="auto"
             style="display:block;height:32px;max-width:120px;object-fit:contain;border:0" />`
      : ''}
  </div>
  <!-- Navy tagline bar -->
  <div style="background:#173454;padding:12px 32px">
    <div style="color:rgba(255,255,255,.75);font-family:Montserrat,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:.1em;font-weight:600">Vi sikrer fremtidens værksted</div>
  </div>
  <div style="padding:32px">${bodyHtml}</div>
  <div style="padding:16px 32px;border-top:1px solid #E0E0E4;font-size:11px;color:#767686">
    CEPELO A/S · Nibevej 54, 9200 Aalborg SV · +45 98 18 09 00 · info@cepelo.dk
  </div>
</div>
</body></html>`

const btn = (href, label) =>
  `<a href="${href}" style="display:inline-block;background:#0868B2;color:#fff;font-family:Montserrat,sans-serif;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:13px 32px;border-radius:27px;text-decoration:none">${label}</a>`

const infoRow = (label, value) =>
  `<tr><td style="font-size:11px;color:#767686;text-transform:uppercase;letter-spacing:.08em;font-weight:600;padding:4px 0;width:140px">${label}</td><td style="font-size:14px;color:#173454;font-weight:600;padding:4px 0">${value || '—'}</td></tr>`

/** Format a number as Danish kroner: 11995 → "11.995 kr" */
function fmtDKK(num) {
  if (!num) return ''
  return Math.round(num).toLocaleString('da-DK') + ' kr'
}

// ─────────────────────────────────────────────────────────────────────────────
// Email templates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Email to the CEPELO seller: "new draft ready – fill in the form".
 * Subject: "Tilbud klar til udfyldning - [quote_ref]"
 */
export function sellerNotificationEmail({ dealerName, quoteRef, products, sellerFormUrl }) {
  const productRows = products.map(p => {
    const qtyStr    = p.quantity > 1 ? ` × ${p.quantity}` : ''
    const priceParts = []
    if (p.net_price   > 0) priceParts.push(`Netto: <strong>${fmtDKK(p.net_price)}</strong>`)
    if (p.gross_price > 0) priceParts.push(`Brutto: <strong>${fmtDKK(p.gross_price)}</strong>`)
    const priceStr  = priceParts.length ? ` &mdash; ${priceParts.join(' / ')}` : ''
    return `<li style="margin:6px 0;font-size:14px;color:#323232">${p.name || p.sku}${qtyStr}${priceStr}</li>`
  }).join('')

  const html = emailShell(`
    <h2 style="font-family:Montserrat,sans-serif;font-size:20px;font-weight:800;color:#173454;margin:0 0 8px">Tilbud klar til udfyldning</h2>
    <p style="font-size:14px;color:#323232;line-height:1.7;margin:0 0 24px">
      En ny ordremail er indgået fra Shopify. Kontrollér produkterne nedenfor og udfyld tilbudsformularen for at sende tilbuddet til forhandleren.
    </p>
    <table style="border-collapse:collapse;background:#F5F5F6;border-radius:8px;padding:16px;width:100%;margin-bottom:24px">
      <tbody>
        ${infoRow('Forhandler', dealerName)}
        ${quoteRef ? infoRow('Ordrenr.', quoteRef) : ''}
      </tbody>
    </table>
    <div style="margin-bottom:28px">
      <div style="font-size:11px;color:#767686;text-transform:uppercase;letter-spacing:.08em;font-weight:600;margin-bottom:10px">Produkter &amp; priser</div>
      <ul style="margin:0;padding-left:20px">${productRows}</ul>
    </div>
    <p style="margin:0 0 24px">${btn(sellerFormUrl, 'Udfyld og send tilbud →')}</p>
    <p style="font-size:12px;color:#767686;margin:0">Eller kopiér linket: <a href="${sellerFormUrl}" style="color:#0868B2">${sellerFormUrl}</a></p>
  `)

  return {
    subject: `Tilbud klar til udfyldning – ${quoteRef || dealerName || 'CEPELO'}`,
    html,
    text: `Tilbud klar til udfyldning.\n\nForhandler: ${dealerName}\nOrdrenr.: ${quoteRef || '—'}\n\nLink: ${sellerFormUrl}`,
  }
}

/**
 * Email to the dealer when the customer has accepted the quote.
 * Subject: "Ordre bekræftet – [quote_ref]"
 */
export function orderConfirmedDealerEmail({ dealerName, dealerEmail, quoteRef, products, orderFormUrl }) {
  const dealerInfo    = getDealerInfo(dealerEmail)
  const dealerLogoUrl = dealerInfo?.logoUrl || null
  const dealerShort   = dealerInfo?.shortName || dealerName || 'forhandler'

  const productRows = products.map(p => {
    const qtyStr = (p.quantity > 1) ? ` × ${p.quantity}` : ''
    const priceStr = (p.gross_price > 0) ? ` — <strong>${fmtDKK(p.gross_price)}</strong>` : ''
    return `<li style="margin:6px 0;font-size:14px;color:#323232">${p.name || p.sku}${qtyStr}${priceStr}</li>`
  }).join('')

  const body = `
    <h2 style="font-family:Montserrat,sans-serif;font-size:20px;font-weight:800;color:#173454;margin:0 0 8px">Ordre bekræftet</h2>
    <p style="font-size:14px;color:#323232;line-height:1.7;margin:0 0 24px">
      Kære ${dealerShort},<br><br>
      Kunden har accepteret tilbuddet. For at vi kan behandle ordren bedes I udfylde jeres værkstedsoplysninger og evt. ordrenummer via knappen nedenfor.
    </p>
    <div style="margin-bottom:28px">
      <div style="font-size:11px;color:#767686;text-transform:uppercase;letter-spacing:.08em;font-weight:600;margin-bottom:10px">Bestilte produkter</div>
      <ul style="margin:0;padding-left:20px">${productRows}</ul>
    </div>
    <p style="margin:0 0 24px">${btn(orderFormUrl, 'Udfyld ordreoplysninger →')}</p>
    <p style="font-size:12px;color:#767686;margin:0">Eller kopiér linket: <a href="${orderFormUrl}" style="color:#0868B2">${orderFormUrl}</a></p>
    <div style="margin-top:28px;padding-top:20px;border-top:1px solid #E0E0E4;font-size:13px;color:#323232;line-height:1.7">
      Med venlig hilsen<br><strong>CEPELO A/S salgsteam</strong><br>
      +45 98 18 09 00 · <a href="mailto:info@cepelo.dk" style="color:#0868B2">info@cepelo.dk</a>
    </div>
  `

  return {
    subject: `Ordre bekræftet${quoteRef ? ' – ' + quoteRef : ''}`,
    html:    emailShell(body, dealerLogoUrl),
    text:    `Kunden har accepteret tilbuddet ${quoteRef || ''}.\n\nUdfyld ordreoplysninger: ${orderFormUrl}`,
  }
}

/**
 * Email to the CEPELO seller when a customer has accepted a quote.
 * Subject: "Tilbud accepteret – [quote_ref]"
 */
export function orderConfirmedSellerEmail({ quoteRef, customerName, customerCompany, dealerName, products, orderFormUrl }) {
  const productRows = products.map(p => {
    const qtyStr    = (p.quantity > 1) ? ` × ${p.quantity}` : ''
    const priceParts = []
    if (p.net_price   > 0) priceParts.push(`Netto: <strong>${fmtDKK(p.net_price)}</strong>`)
    if (p.gross_price > 0) priceParts.push(`Brutto: <strong>${fmtDKK(p.gross_price)}</strong>`)
    const priceStr = priceParts.length ? ` &mdash; ${priceParts.join(' / ')}` : ''
    return `<li style="margin:6px 0;font-size:14px;color:#323232">${p.name || p.sku}${qtyStr}${priceStr}</li>`
  }).join('')

  const customerLine = [customerName, customerCompany].filter(Boolean).join(' / ')

  const body = `
    <h2 style="font-family:Montserrat,sans-serif;font-size:20px;font-weight:800;color:#173454;margin:0 0 8px">Tilbud accepteret 🎉</h2>
    <p style="font-size:14px;color:#323232;line-height:1.7;margin:0 0 24px">
      ${customerLine ? `<strong>${customerLine}</strong> har accepteret tilbuddet.` : 'Et tilbud er blevet accepteret.'} Vi afventer nu at <strong>${dealerName || 'forhandleren'}</strong> indsender værkstedsoplysninger.
    </p>
    <table style="border-collapse:collapse;background:#F5F5F6;border-radius:8px;padding:16px;width:100%;margin-bottom:24px">
      <tbody>
        ${quoteRef     ? infoRow('Ordrenr.',    quoteRef)      : ''}
        ${dealerName   ? infoRow('Forhandler',  dealerName)    : ''}
        ${customerLine ? infoRow('Kunde',       customerLine)  : ''}
      </tbody>
    </table>
    <div style="margin-bottom:28px">
      <div style="font-size:11px;color:#767686;text-transform:uppercase;letter-spacing:.08em;font-weight:600;margin-bottom:10px">Bestilte produkter</div>
      <ul style="margin:0;padding-left:20px">${productRows}</ul>
    </div>
    <p style="font-size:13px;color:#767686;margin:0 0 24px">Forhandleren er bedt om at udfylde ordreoplysninger via: <a href="${orderFormUrl}" style="color:#0868B2">${orderFormUrl}</a></p>
    <p style="font-size:13px;color:#767686;margin:0">Du modtager en ny notifikation, når forhandleren har indsendt oplysningerne.</p>
  `

  return {
    subject: `Tilbud accepteret${quoteRef ? ' – ' + quoteRef : ''}`,
    html:    emailShell(body),
    text:    `Tilbud ${quoteRef || ''} er accepteret af ${customerLine || 'kunden'}.\n\nForhandler: ${dealerName || '—'}\nOrdreformular: ${orderFormUrl}`,
  }
}

/**
 * Email to the CEPELO seller when a dealer submits workshop/order details.
 * Subject: "Ordreoplysninger modtaget – [quote_ref]"
 */
export function workshopDetailsSellerEmail({ quoteRef, dealerName, workshop, products }) {
  const productRows = products.map(p => {
    const qtyStr    = (p.quantity > 1) ? ` × ${p.quantity}` : ''
    const priceParts = []
    if (p.net_price   > 0) priceParts.push(`Netto: <strong>${fmtDKK(p.net_price)}</strong>`)
    if (p.gross_price > 0) priceParts.push(`Brutto: <strong>${fmtDKK(p.gross_price)}</strong>`)
    const priceStr = priceParts.length ? ` &mdash; ${priceParts.join(' / ')}` : ''
    return `<li style="margin:6px 0;font-size:14px;color:#323232">${p.name || p.sku}${qtyStr}${priceStr}</li>`
  }).join('')

  const body = `
    <h2 style="font-family:Montserrat,sans-serif;font-size:20px;font-weight:800;color:#173454;margin:0 0 8px">Ordreoplysninger modtaget</h2>
    <p style="font-size:14px;color:#323232;line-height:1.7;margin:0 0 24px">
      <strong>${dealerName || 'Forhandleren'}</strong> har indsendt værkstedsoplysninger. Du kan nu behandle ordren i Shopify.
    </p>
    <table style="border-collapse:collapse;background:#F5F5F6;border-radius:8px;padding:16px;width:100%;margin-bottom:24px">
      <tbody>
        ${quoteRef                    ? infoRow('Ordrenr.',         quoteRef)                 : ''}
        ${workshop.company_name       ? infoRow('Værkstedsnavn',    workshop.company_name)     : ''}
        ${workshop.address            ? infoRow('Adresse',          workshop.address)          : ''}
        ${workshop.cvr                ? infoRow('CVR',              workshop.cvr)              : ''}
        ${workshop.contact_name       ? infoRow('Kontaktperson',    workshop.contact_name)     : ''}
        ${workshop.contact_email      ? infoRow('Email',            workshop.contact_email)    : ''}
        ${workshop.contact_phone      ? infoRow('Telefon',          workshop.contact_phone)    : ''}
        ${workshop.po_number          ? infoRow('PO-nummer',        workshop.po_number)        : ''}
      </tbody>
    </table>
    <div style="margin-bottom:24px">
      <div style="font-size:11px;color:#767686;text-transform:uppercase;letter-spacing:.08em;font-weight:600;margin-bottom:10px">Bestilte produkter</div>
      <ul style="margin:0;padding-left:20px">${productRows}</ul>
    </div>
  `

  return {
    subject: `Ordreoplysninger modtaget${quoteRef ? ' – ' + quoteRef : ''}`,
    html:    emailShell(body),
    text:    `Ordreoplysninger modtaget for ${quoteRef || 'ordre'}.\n\nVærksted: ${workshop.company_name || '—'}\nCVR: ${workshop.cvr || '—'}\nKontakt: ${workshop.contact_name || '—'}`,
  }
}

/**
 * Shorten/clean a dealer name for email subjects and sign-offs.
 * Keeps 1–4 char all-caps tokens as acronyms; title-cases the rest.
 *   "FTZ AUTODELE"  → "FTZ Autodele"
 *   "AD DANMARK"    → "AD Danmark"
 *   "WM AUTODELE"   → "WM Autodele"
 */
function formatDealerNameShort(name) {
  if (!name) return ''
  return name.trim()
    .split(/\s+/)
    .map(w => /^[A-Z0-9]{1,4}$/.test(w)
      ? w
      : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    )
    .join(' ')
}

/**
 * Email to the dealer (or end-customer): "here is your quote link".
 * Subject: "Tilbud til [DealerName] – [quote_ref]"
 *
 * @param {{
 *   dealerName: string,
 *   dealerEmail?: string,
 *   quoteRef: string,
 *   products: Array,
 *   quoteUrl: string,
 *   senderName?: string,
 *   senderTitle?: string,
 *   senderEmail?: string,
 *   senderPhone?: string,
 *   senderPhoto?: string|null,
 *   notes?: string,
 * }} opts
 */
export function dealerQuoteEmail({ dealerName, dealerEmail, quoteRef, products, quoteUrl, senderName, senderTitle, senderEmail, senderPhone, senderPhoto, notes }) {
  const productRows = products.map(p => {
    const qtyStr = p.quantity > 1 ? ` × ${p.quantity}` : ''
    return `<li style="margin:4px 0;font-size:14px;color:#323232">${p.name || p.sku}${qtyStr}</li>`
  }).join('')

  // Dealer branding: known table wins; falls back to Brandfetch for unknown domains
  const dealerInfo    = getDealerInfo(dealerEmail)
  const dealerLogoUrl = dealerInfo?.logoUrl || null
  // Short subject name: explicit table entry > computed abbreviation
  const dealerShort   = dealerInfo?.shortName || formatDealerNameShort(dealerName)

  // ── Intro paragraph ──────────────────────────────────────────────────────────
  // If the seller wrote a note, use it verbatim as the intro.
  // Otherwise: "Hermed fremsendes tilbud vedrørende [first product name]."
  let introHtml
  if (notes && notes.trim()) {
    introHtml = `<p style="font-size:14px;color:#323232;line-height:1.7;margin:0 0 24px;white-space:pre-wrap">${notes.trim()}</p>`
  } else {
    const firstProductName = (products[0]?.name || products[0]?.sku || 'dette produkt').trim()
    introHtml = `<p style="font-size:14px;color:#323232;line-height:1.7;margin:0 0 24px">Hermed fremsendes tilbud vedr&aelig;rende ${firstProductName}.</p>`
  }

  // ── Sender signature ─────────────────────────────────────────────────────────
  const photoBlock = senderPhoto
    ? `<img src="${senderPhoto}" alt="${senderName || ''}" width="64" height="64"
         style="display:block;width:64px;height:64px;border-radius:50%;object-fit:cover;margin-bottom:10px;border:2px solid #E0E0E4" />`
    : ''

  const signatureBlock = `
    <div style="margin-top:28px;padding-top:20px;border-top:1px solid #E0E0E4">
      <p style="font-size:12px;color:#767686;margin:0 0 12px;text-transform:uppercase;letter-spacing:.06em;font-weight:600">Med venlig hilsen</p>
      ${photoBlock}
      ${senderName  ? `<p style="font-size:15px;font-weight:700;color:#173454;font-family:Montserrat,sans-serif;margin:0 0 2px">${senderName}</p>` : ''}
      ${senderTitle ? `<p style="font-size:12px;color:#767686;margin:0 0 6px">${senderTitle} &mdash; CEPELO A/S</p>` : `<p style="font-size:12px;color:#767686;margin:0 0 6px">CEPELO A/S</p>`}
      ${senderPhone ? `<p style="font-size:12px;color:#767686;margin:2px 0">${senderPhone}</p>` : ''}
      ${senderEmail ? `<p style="font-size:12px;margin:2px 0"><a href="mailto:${senderEmail}" style="color:#0868B2;text-decoration:none">${senderEmail}</a></p>` : ''}
    </div>
  `

  const body = `
    <h2 style="font-family:Montserrat,sans-serif;font-size:20px;font-weight:800;color:#173454;margin:0 0 8px">Dit tilbud fra CEPELO</h2>
    <p style="font-size:14px;color:#323232;line-height:1.7;margin:0 0 16px">Kære ${dealerShort || dealerName || 'forhandler'},</p>
    ${introHtml}
    <div style="margin-bottom:28px">
      <div style="font-size:11px;color:#767686;text-transform:uppercase;letter-spacing:.08em;font-weight:600;margin-bottom:10px">Produkter i tilbuddet</div>
      <ul style="margin:0;padding-left:20px">${productRows}</ul>
    </div>
    <p style="margin:0 0 32px">${btn(quoteUrl, 'Se tilbuddet →')}</p>
    ${signatureBlock}
  `
  const html = emailShell(body, dealerLogoUrl)

  const subjectDealerPart = dealerShort || dealerName || ''
  return {
    subject: `Tilbud til ${subjectDealerPart}${quoteRef ? ' – ' + quoteRef : ''}`,
    html,
    text: `Tilbud til ${subjectDealerPart}${quoteRef ? ' – ' + quoteRef : ''}.\n\nSe tilbuddet her: ${quoteUrl}`,
  }
}
