// pages/api/parse-email.js
//
// Fetches a Shopify draft order by its reference number (extracted from the
// email subject), enriches each SKU line item with Shopify Storefront product
// data, and creates a quote in Supabase.
//
// POST /api/parse-email
// Headers : x-cepelo-secret: <CEPELO_API_SECRET>
// Body (JSON):
//   subject    – email subject line (required; provides order ref, type, and
//                customer name e.g. "FORHANDLER | Slutkunde: X - Tilbud #D4760")
//   body_html  – raw HTML of the notification email (optional; used only as a
//                fallback when the subject doesn't contain the order reference)
//   html       – alias for body_html (also accepted)
//   lang       – "da" | "no" | "is"  (default "da")
//   valid_days – quote validity in days (default 30)
//   seller_email – RFC 5322 From header value from Power Automate
//
// Query params:
//   ?debug=1   – fetch + parse but return structured data WITHOUT creating a quote
//
// Subject formats recognised:
//   "FORHANDLER | Slutkunde: Greve Autoværksted - Tilbud #D4735"
//     → type=dealer,   recipient_company="Greve Autoværksted", quote_ref="#D4735"
//   "SLUTKUNDE | Kunde: Hans Nielsen - Tilbud #D4735"
//     → type=customer, recipient_company="Hans Nielsen",       quote_ref="#D4735"

import { createClient } from '@supabase/supabase-js'
import { randomBytes }  from 'crypto'
import { fetchProductBySku, fetchDraftOrderByRef } from '../../lib/shopify'
import { getAccessoriesForSku } from '../../lib/accessories'
import { sendEmail, sellerNotificationEmail } from '../../lib/email'

const adminClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ─────────────────────────────────────────────────────────────────────────────
// HTML utilities (kept for fallback quote-ref / recipient extraction from body)
// ─────────────────────────────────────────────────────────────────────────────

function decodeEntities(str) {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
}

/** Strip HTML tags, turning block-level tags into newlines. */
function stripTags(html) {
  return decodeEntities(
    html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(p|div|tr|li|h[1-6]|td|th)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]*/g,  '\n')
    .replace(/\n{3,}/g,    '\n\n')
    .trim()
}

// ─────────────────────────────────────────────────────────────────────────────
// Price parsing  –  handles "44.995,00 DKK", "44,995.00", "44995", "150 kr."
// ─────────────────────────────────────────────────────────────────────────────

function parsePrice(raw) {
  if (!raw) return 0
  const s = raw.replace(/[^\d.,]/g, '').trim()
  if (!s) return 0
  let n
  if (/,\d{1,2}$/.test(s) && s.includes('.')) {
    n = parseFloat(s.replace(/\./g, '').replace(',', '.'))
  } else if (/\.\d{1,2}$/.test(s) && s.includes(',')) {
    n = parseFloat(s.replace(/,/g, ''))
  } else if (/,\d{1,2}$/.test(s)) {
    n = parseFloat(s.replace(',', '.'))
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    n = parseFloat(s.replace(/\./g, ''))
  } else {
    n = parseFloat(s.replace(',', ''))
  }
  return isNaN(n) ? 0 : Math.round(n)
}

// ─────────────────────────────────────────────────────────────────────────────
// Subject parser
// ─────────────────────────────────────────────────────────────────────────────

function parseSubject(subject = '') {
  const s = subject.trim()

  // "FORHANDLER | Slutkunde: Greve Autoværksted - Tilbud #D4735"
  const dealerRe = /FORHANDLER\s*\|[^:]*:\s*(.+?)\s*[-–]\s*Tilbud\s*(#[A-Z0-9]+)/i
  const dealerM  = s.match(dealerRe)
  if (dealerM) {
    return { type: 'dealer', recipient_company: dealerM[1].trim(), quote_ref: dealerM[2] }
  }

  // "SLUTKUNDE | Kunde: Hans Nielsen - Tilbud #D4735"
  const custRe = /SLUTKUNDE\s*\|[^:]*:\s*(.+?)\s*[-–]\s*Tilbud\s*(#[A-Z0-9]+)/i
  const custM  = s.match(custRe)
  if (custM) {
    return { type: 'customer', recipient_company: custM[1].trim(), quote_ref: custM[2] }
  }

  // Fallback – extract any quote ref
  const refM = s.match(/(#[A-Z0-9]+)/i)
  return { type: 'dealer', recipient_company: '', quote_ref: refM?.[1] ?? null }
}

// ─────────────────────────────────────────────────────────────────────────────
// Quote number fallback (from body when not in subject)
// ─────────────────────────────────────────────────────────────────────────────

function parseQuoteRef(html) {
  const text = stripTags(html)
  const m    = text.match(/(?:Tilbud|Draft\s+order|Order)\s*(#[A-Z0-9]+)/i)
  return m ? m[1] : null
}

// ─────────────────────────────────────────────────────────────────────────────
// Build line items from a Shopify draft order object
//
// Price semantics (Shopify Admin REST):
//   item.price             – original unit price BEFORE any line-level discount
//   item.applied_discount  – { amount: "<total_line_discount>", type, value }
//   net_price per unit     = price − (applied_discount.amount / quantity)
//
//   Custom items (item.custom === true) have no catalog product; they map to
//   manual line items (Montage, Diverse olie, etc.).
// ─────────────────────────────────────────────────────────────────────────────

function buildItemsFromDraftOrder(draftOrder) {
  const skuItems    = []
  const manualItems = []
  const discounts   = []
  let   delivery    = null

  for (const item of (draftOrder.line_items || [])) {
    const unitPrice   = parseFloat(item.price || 0)
    const discountAmt = parseFloat(item.applied_discount?.amount || 0)
    const qty         = Math.max(item.quantity || 1, 1)
    // Shopify price = original unit price BEFORE line discount;
    // applied_discount.amount = total discount for the whole line (not per unit)
    const net_price   = Math.round(unitPrice - discountAmt / qty)

    // Non-custom items with a SKU → catalog product line
    const hasSku = item.sku && item.sku.trim() && !item.custom
    if (hasSku) {
      skuItems.push({
        sku:      item.sku.trim().toUpperCase(),
        name:     item.title || item.sku,
        quantity: qty,
        net_price,
      })
    } else {
      // Custom items (services, manual additions, etc.)
      manualItems.push({
        sku:         null,
        name:        item.title || '(manual)',
        quantity:    qty,
        net_price,
        gross_price: net_price,
        type:        'manual',
      })
    }
  }

  // Shipping line
  const shippingPrice = parseFloat(draftOrder.shipping_line?.price || 0)
  if (shippingPrice > 0) delivery = Math.round(shippingPrice)

  // Order-level discount (applied_discount on the draft order itself, not line-level)
  const od = draftOrder.applied_discount
  if (od && parseFloat(od.amount || 0) > 0) {
    const amt = Math.round(parseFloat(od.amount))
    discounts.push({
      sku:         null,
      name:        od.title || 'Rabat',
      quantity:    1,
      net_price:   -amt,
      gross_price: -amt,
      type:        'discount',
    })
  }

  // Shipping address → dealer name + formatted delivery address
  const sa         = draftOrder.shipping_address || {}
  const dealerName = sa.company || [sa.first_name, sa.last_name].filter(Boolean).join(' ') || ''
  const addrParts  = [
    sa.address1,
    sa.address2,
    [sa.zip, sa.city].filter(Boolean).join(' '),
    sa.country,
  ].filter(Boolean)
  const address = { company: dealerName, address: addrParts.join(', ') }

  return { skuItems, manualItems, delivery, discounts, address }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const secret = req.headers['x-cepelo-secret']
  if (secret !== process.env.CEPELO_API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const {
    subject      = '',
    body_html,
    html: html_field,
    lang         = 'da',
    valid_days   = 30,
    seller_email = '',   // Power Automate: @{triggerOutputs()?['body/from']}
  } = req.body

  const debug = req.query.debug === '1'

  // Parse "Name <email>" or bare "email" from the From header value
  const fromMatch  = seller_email.match(/^(.+?)\s*<([^>]+)>/)
  const sellerName = fromMatch ? fromMatch[1].trim() : ''
  const sellerAddr = fromMatch ? fromMatch[2].trim() : seller_email.trim()

  // ── 1. Parse subject → extract quote_ref, type, recipient ─────────────────
  const subjectData = parseSubject(subject)

  // If subject didn't yield a quote ref, try the email body HTML as fallback
  if (!subjectData.quote_ref) {
    const emailHtml = (body_html || html_field || '')
      .replace(/&nbsp;/g, ' ').replace(/&#160;/g, ' ')
    subjectData.quote_ref = parseQuoteRef(emailHtml)
  }

  // Also try subject-style markers in the first 400 chars of the body text
  if (!subjectData.recipient_company) {
    const bodyText = stripTags(body_html || html_field || '').slice(0, 400)
    const dealerM  = bodyText.match(/FORHANDLER\s*\|[^:]*:\s*(.+?)\s*[-–\n]/i)
    const custM    = bodyText.match(/SLUTKUNDE\s*\|[^:]*:\s*(.+?)\s*[-–\n]/i)
    if (dealerM) { subjectData.type = 'dealer';   subjectData.recipient_company = dealerM[1].trim() }
    if (custM)   { subjectData.type = 'customer'; subjectData.recipient_company = custM[1].trim() }
  }

  if (!subjectData.quote_ref) {
    return res.status(422).json({
      error:   'No quote reference found in subject or email body',
      hint:    'Subject must contain "Tilbud #DXXXX"',
      subject: subjectData,
    })
  }

  // ── 2. Fetch draft order from Shopify Admin API ───────────────────────────
  let draftOrder = null
  try {
    draftOrder = await fetchDraftOrderByRef(subjectData.quote_ref)
  } catch (e) {
    console.error('[parse-email] Shopify Admin API error:', e.message)
    return res.status(502).json({ error: `Shopify API error: ${e.message}` })
  }

  if (!draftOrder) {
    return res.status(422).json({
      error:   `Draft order ${subjectData.quote_ref} not found in Shopify`,
      hint:    'Check that the order reference in the subject matches an existing Shopify draft order',
      subject: subjectData,
    })
  }

  // ── 3. Build items from the draft order ──────────────────────────────────
  const { skuItems, manualItems, delivery, discounts, address } =
    buildItemsFromDraftOrder(draftOrder)

  if (skuItems.length === 0) {
    return res.status(422).json({
      error:   'Draft order has no product line items with SKUs',
      hint:    'Ensure the draft order contains at least one catalog product with a SKU/variant',
      subject: subjectData,
      order:   { id: draftOrder.id, name: draftOrder.name },
    })
  }

  // ── 4. Shopify Storefront enrichment (images, descriptions, gross_price) ──
  const enriched = await Promise.all(
    skuItems.map(async item => {
      let shopify = null
      try {
        shopify = await fetchProductBySku(item.sku)
        if (!shopify) console.warn(`[parse-email] SKU ${item.sku} not found in Shopify Storefront`)
      } catch (e) {
        console.warn(`[parse-email] Shopify Storefront error for ${item.sku}:`, e.message)
      }
      return { ...item, shopify }
    })
  )

  // ── 5. Build main_product + line_items ───────────────────────────────────
  const [first, ...rest] = enriched
  const isCustomerQuote  = subjectData.type === 'customer'

  function buildProduct(item) {
    const s = item.shopify
    return {
      // Shopify Storefront data as base (when available)
      ...(s && {
        name:               s.name,
        description:        s.description,
        description_html:   s.description_html,
        image_url:          s.image_url,
        images:             s.images,
        currency:           s.currency,
        vendor:             s.vendor,
        product_type:       s.product_type,
        shopify_handle:     s.handle,
        shopify_product_id: s.shopify_product_id,
      }),
      sku:      item.sku,
      name:     s?.name || item.name,
      quantity: item.quantity,
      // Price semantics differ by type:
      //   dealer   → Admin API price = net (dealer cost); Storefront gross = suggested retail
      //   customer → Admin API price IS the gross (agreed customer price); no net concept
      net_price:   isCustomerQuote ? 0              : item.net_price,
      gross_price: isCustomerQuote ? item.net_price : (s?.gross_price || 0),
    }
  }

  const main_product = buildProduct(first)
  const line_items   = rest.map(buildProduct)

  // Manual lines (custom order items, services, etc.) — no Shopify enrichment
  manualItems.forEach(item => line_items.push({
    sku:         null,
    name:        item.name,
    quantity:    item.quantity,
    net_price:   isCustomerQuote ? 0              : item.net_price,
    gross_price: isCustomerQuote ? item.net_price : item.gross_price,
    type:        'manual',
  }))

  // Delivery as a synthetic line item when present
  if (delivery !== null) {
    line_items.push({
      sku:         'DELIVERY',
      name:        'Levering',
      quantity:    1,
      net_price:   delivery,
      gross_price: delivery,
      currency:    'DKK',
    })
  }

  // Discount lines from the draft order
  discounts.forEach(d => line_items.push(d))

  // ── 6. Accessories (static catalogue lookup) ─────────────────────────────
  const available_accessories = getAccessoriesForSku(first.sku)

  // ── 7. Build parsed summary ──────────────────────────────────────────────
  const parsedSummary = {
    type:               subjectData.type,
    quote_ref:          subjectData.quote_ref,
    recipient_company:  subjectData.recipient_company,
    dealer_name:        address.company,
    delivery,
    address:            address.address,
    items: [
      ...enriched.map(i => ({
        sku:        i.sku,
        name:       i.shopify?.name || i.name,
        quantity:   i.quantity,
        net_price:  i.net_price,
        shopify_ok: !!i.shopify,
      })),
      ...manualItems.map(i => ({
        sku:       null,
        name:      i.name,
        quantity:  i.quantity,
        net_price: i.net_price,
        type:      'manual',
      })),
      ...discounts.map(d => ({
        sku:       null,
        name:      d.name,
        net_price: d.net_price,
        type:      'discount',
      })),
    ],
    accessories_count: available_accessories.length,
    discount_count:    discounts.length,
  }

  // ── 8. Debug mode – return data without writing to Supabase ──────────────
  if (debug) {
    return res.status(200).json({
      debug: true,
      shopify_draft_order: {
        id:               draftOrder.id,
        name:             draftOrder.name,
        status:           draftOrder.status,
        currency:         draftOrder.currency,
        subtotal_price:   draftOrder.subtotal_price,
        total_price:      draftOrder.total_price,
        applied_discount: draftOrder.applied_discount,
        shipping_line:    draftOrder.shipping_line,
        shipping_address: draftOrder.shipping_address,
        line_items: (draftOrder.line_items || []).map(i => ({
          title:            i.title,
          sku:              i.sku,
          quantity:         i.quantity,
          price:            i.price,
          custom:           i.custom,
          applied_discount: i.applied_discount,
        })),
      },
      parsed:      parsedSummary,
      main_product,
      line_items,
    })
  }

  // ── 9. Insert DRAFT quote into Supabase ──────────────────────────────────
  const token          = randomBytes(16).toString('hex')
  const customer_token = randomBytes(16).toString('hex')
  const draft_token    = randomBytes(16).toString('hex')
  const validUntil     = new Date()
  validUntil.setDate(validUntil.getDate() + valid_days)

  const { error } = await adminClient.from('quotes').insert({
    token,
    customer_token,
    draft_token,
    shopify_order_id:      subjectData.quote_ref || 'PARSED',
    type:                  subjectData.type,
    lang,
    category:              'other',
    status:                'draft',
    sender_name:           sellerName || '',
    sender_email:          sellerAddr || process.env.DEFAULT_SENDER_EMAIL || '',
    sender_phone:          '',
    recipient_name:        '',
    recipient_company:     subjectData.recipient_company || '',
    recipient_email:       '',
    recipient_phone:       '',
    dealer_name:           address.company || '',
    dealer_email:          '',
    main_product,
    line_items,
    available_accessories,
    notes:                 address.address ? `Leveringsadresse: ${address.address}` : '',
    valid_until:           validUntil.toISOString().split('T')[0],
  })

  if (error) {
    console.error('[parse-email] Supabase insert error:', error)
    return res.status(500).json({ error: `Supabase error: ${error.message}` })
  }

  const baseUrl       = process.env.NEXT_PUBLIC_BASE_URL
  const sellerFormUrl = `${baseUrl}/seller/${draft_token}`

  // ── 10. Notify the CEPELO seller ─────────────────────────────────────────
  const notifyEmail = sellerAddr || process.env.DEFAULT_SENDER_EMAIL
  if (notifyEmail) {
    try {
      const allProducts = [main_product, ...line_items.filter(i => i.sku !== 'DELIVERY')]
      const tpl = sellerNotificationEmail({
        dealerName:    address.company || subjectData.recipient_company || '',
        quoteRef:      subjectData.quote_ref,
        products:      allProducts,
        sellerFormUrl,
      })
      await sendEmail({ to: notifyEmail, ...tpl })
    } catch (emailErr) {
      // Non-fatal — the quote was created; just log
      console.warn('[parse-email] Seller notification email failed:', emailErr.message)
    }
  }

  return res.status(200).json({
    success:         true,
    draft_token,
    seller_form_url: sellerFormUrl,
    seller_email:    sellerAddr || null,
    parsed:          parsedSummary,
  })
}

// Named exports used by /api/test-parse
export { parseSubject, parseQuoteRef, stripTags, parsePrice, buildItemsFromDraftOrder }
