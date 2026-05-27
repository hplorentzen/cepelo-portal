// lib/email.js
// Nodemailer wrapper for transactional emails.
//
// Required env vars (set in Vercel dashboard):
//   SMTP_HOST   – e.g. smtp.sendgrid.net / mail.cepelo.dk
//   SMTP_USER   – SMTP username / "apikey" for SendGrid
//   SMTP_PASS   – SMTP password / API key
//
// Optional:
//   SMTP_PORT   – default 587  (use 465 for TLS)
//   SMTP_FROM   – display name + address, e.g. "CEPELO A/S <tilbud@cepelo.dk>"
//                 falls back to DEFAULT_SENDER_EMAIL
//
// If SMTP_HOST is not set the email is only logged to console — useful in dev.

import nodemailer from 'nodemailer'

function makeTransporter() {
  const host = process.env.SMTP_HOST
  if (!host) return null
  return nodemailer.createTransport({
    host,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
  })
}

/**
 * Send a transactional email.
 * @param {{ to: string, subject: string, html: string, text?: string }} opts
 */
export async function sendEmail({ to, subject, html, text }) {
  const from = process.env.SMTP_FROM
    || `CEPELO A/S <${process.env.DEFAULT_SENDER_EMAIL || 'tilbud@cepelo.dk'}>`

  const transporter = makeTransporter()

  if (!transporter) {
    console.log('[email] SMTP not configured – logging to console instead')
    console.log(`  To:      ${to}`)
    console.log(`  Subject: ${subject}`)
    if (text) console.log(`  Body:    ${text.slice(0, 200)}`)
    return { messageId: 'console-only' }
  }

  const info = await transporter.sendMail({ from, to, subject, html, text })
  console.log(`[email] Sent "${subject}" → ${to} (${info.messageId})`)
  return info
}

// ─────────────────────────────────────────────────────────────────────────────
// Email templates
// ─────────────────────────────────────────────────────────────────────────────

const emailShell = (bodyHtml) => `<!DOCTYPE html>
<html lang="da">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;background:#F5F5F6;margin:0;padding:32px 16px">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #E0E0E4">
  <div style="background:#173454;padding:24px 32px">
    <div style="font-family:Montserrat,sans-serif;color:#fff;font-size:20px;font-weight:800;text-transform:uppercase;letter-spacing:.08em">CEPELO</div>
    <div style="color:rgba(255,255,255,.6);font-size:11px;margin-top:3px;text-transform:uppercase;letter-spacing:.08em">Workshop Equipment Solutions</div>
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

/**
 * Email to the CEPELO seller: "new draft ready – fill in the form".
 */
export function sellerNotificationEmail({ dealerName, quoteRef, products, sellerFormUrl }) {
  const productRows = products.map(p =>
    `<li style="margin:4px 0;font-size:14px;color:#323232">${p.name || p.sku}${p.quantity > 1 ? ` × ${p.quantity}` : ''}</li>`
  ).join('')

  const html = emailShell(`
    <h2 style="font-family:Montserrat,sans-serif;font-size:20px;font-weight:800;color:#173454;margin:0 0 8px">Nyt tilbud klar til udfyldning</h2>
    <p style="font-size:14px;color:#323232;line-height:1.7;margin:0 0 24px">
      En ny ordremail fra Shopify er indgået. Udfyld tilbudsformularen for at sende tilbuddet til forhandleren.
    </p>
    <table style="border-collapse:collapse;background:#F5F5F6;border-radius:8px;padding:16px;width:100%;margin-bottom:24px">
      <tbody>
        ${infoRow('Forhandler', dealerName)}
        ${quoteRef ? infoRow('Ordrenr.', quoteRef) : ''}
      </tbody>
    </table>
    <div style="margin-bottom:28px">
      <div style="font-size:11px;color:#767686;text-transform:uppercase;letter-spacing:.08em;font-weight:600;margin-bottom:10px">Produkter</div>
      <ul style="margin:0;padding-left:20px">${productRows}</ul>
    </div>
    <p style="margin:0 0 24px">${btn(sellerFormUrl, 'Udfyld og send tilbud →')}</p>
    <p style="font-size:12px;color:#767686;margin:0">Eller kopiér linket: <a href="${sellerFormUrl}" style="color:#0868B2">${sellerFormUrl}</a></p>
  `)

  return {
    subject: `Nyt tilbud klar – ${dealerName || quoteRef || 'CEPELO'}`,
    html,
    text: `Nyt tilbud klar til udfyldning.\n\nForhandler: ${dealerName}\nLink: ${sellerFormUrl}`,
  }
}

/**
 * Email to the dealer: "here is your quote link".
 */
export function dealerQuoteEmail({ dealerName, quoteRef, products, quoteUrl, senderName }) {
  const productRows = products.map(p =>
    `<li style="margin:4px 0;font-size:14px;color:#323232">${p.name || p.sku}${p.quantity > 1 ? ` × ${p.quantity}` : ''}</li>`
  ).join('')

  const html = emailShell(`
    <h2 style="font-family:Montserrat,sans-serif;font-size:20px;font-weight:800;color:#173454;margin:0 0 8px">Dit tilbud fra CEPELO</h2>
    <p style="font-size:14px;color:#323232;line-height:1.7;margin:0 0 24px">
      Kære ${dealerName || 'forhandler'},<br><br>
      Hermed fremsendes tilbud fra CEPELO A/S.${quoteRef ? ` Ordrenr.: <strong>${quoteRef}</strong>.` : ''}
    </p>
    <div style="margin-bottom:28px">
      <div style="font-size:11px;color:#767686;text-transform:uppercase;letter-spacing:.08em;font-weight:600;margin-bottom:10px">Produkter i tilbuddet</div>
      <ul style="margin:0;padding-left:20px">${productRows}</ul>
    </div>
    <p style="margin:0 0 24px">${btn(quoteUrl, 'Se tilbuddet →')}</p>
    <p style="font-size:12px;color:#767686;margin:0">Eller kopiér linket: <a href="${quoteUrl}" style="color:#0868B2">${quoteUrl}</a></p>
    ${senderName ? `<p style="font-size:13px;color:#323232;margin:24px 0 0">Med venlig hilsen,<br><strong>${senderName}</strong><br>CEPELO A/S</p>` : ''}
  `)

  return {
    subject: `Tilbud fra CEPELO${quoteRef ? ' – ' + quoteRef : ''}`,
    html,
    text: `Dit tilbud fra CEPELO.\n\nSe tilbuddet: ${quoteUrl}`,
  }
}
