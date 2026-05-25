// pages/api/parse-email.js
//
// Parses a Shopify draft-order notification email, enriches each line item
// with Shopify product data, and creates a quote in Supabase.
//
// POST /api/parse-email
// Headers : x-cepelo-secret: <CEPELO_API_SECRET>
// Body (JSON):
//   subject    – email subject line (used to detect type + customer name)
//   body_html  – raw HTML of the notification email (required)
//   lang       – "da" | "no" | "is"  (default "da")
//   valid_days – quote validity in days (default 30)
//
// Query params:
//   ?debug=1   – parse and return structured data WITHOUT creating a quote
//
// Subject formats recognised:
//   "FORHANDLER | Slutkunde: Greve Autoværksted - Tilbud #D4735"
//     → type=dealer,   recipient_company="Greve Autoværksted", quote_ref="#D4735"
//   "SLUTKUNDE | Kunde: Hans Nielsen - Tilbud #D4735"
//     → type=customer, recipient_company="Hans Nielsen",       quote_ref="#D4735"

import { createClient } from '@supabase/supabase-js'
import { randomBytes }  from 'crypto'
import { fetchProductBySku, fetchProductRecommendations } from '../../lib/shopify'
import { getAccessoriesForSku }                           from '../../lib/accessories'

const adminClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ─────────────────────────────────────────────────────────────────────────────
// HTML utilities
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
  // Strip everything that is not a digit, dot, or comma
  const s = raw.replace(/[^\d.,]/g, '').trim()
  if (!s) return 0

  let n
  // "44.995,00" – Danish (dot = thousands sep, comma = decimal)
  if (/,\d{1,2}$/.test(s) && s.includes('.')) {
    n = parseFloat(s.replace(/\./g, '').replace(',', '.'))
  // "44,995.00" – English (comma = thousands sep, dot = decimal)
  } else if (/\.\d{1,2}$/.test(s) && s.includes(',')) {
    n = parseFloat(s.replace(/,/g, ''))
  // "44995,00" or "150,00" – bare decimal comma
  } else if (/,\d{1,2}$/.test(s)) {
    n = parseFloat(s.replace(',', '.'))
  // "44.995" – may be thousands-separated integer
  } else if (/^\d{1,3}\.\d{3}$/.test(s)) {
    n = parseFloat(s.replace('.', ''))
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
// Line item parser
// Two-pass strategy:
//   Pass 1 – table-row based (precise: td cells give name / sku / price columns)
//   Pass 2 – text-window based (fallback for non-table or deeply nested layouts)
// ─────────────────────────────────────────────────────────────────────────────

const SKU_RE    = /\bSKU\s*:?\s*([A-Z][A-Z0-9\-_]{2,20})\b/i
// Also handle Danish "Varenr." label
const SKU_RE_G  = /\b(?:SKU|Varenr\.?)\s*:?\s*([A-Z][A-Z0-9\-_]{2,20})\b/gi
const PRICE_RE  = /([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)\s*(?:DKK|kr\.?)/gi
// "N ×" quantity prefix that appears in Shopify "1 × 44.995,00 DKK" lines
const QTY_X_RE  = /(\d+)\s*[×xX]\s*([\d.,]+)/

/** Lines to ignore when looking for product names */
function isNoiseLine(line) {
  return (
    line.length < 3 ||
    /^\s*$/.test(line) ||
    /^(?:SKU|Varenr|Art\.?nr)/i.test(line) ||
    /^(?:Antal|Mængde|Qty|Quantity)\s*:/i.test(line) ||
    /^(?:Subtotal|Levering|Fragt|Forsendelse|Shipping|I\s+alt|Total|Moms|Skat)\b/i.test(line) ||
    /^[\d.,\s]+(?:DKK|kr\.?)?$/i.test(line)
  )
}

function parseLineItems(html) {
  const items = []
  const seen  = new Set()   // deduplicate by SKU

  // ── Pass 1: table-row based ───────────────────────────────────────────────
  // Iterate every <tr> and check whether its text contains a SKU pattern.
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  let trM
  while ((trM = trRe.exec(html)) !== null) {
    const rowHtml = trM[1]
    const rowText = stripTags(rowHtml)

    const skuM = rowText.match(SKU_RE)
    if (!skuM) continue
    const sku = skuM[1].toUpperCase()
    if (seen.has(sku)) continue

    // Product name: meaningful non-noise lines before the SKU line
    const lines   = rowText.split('\n').map(l => l.trim())
    const skuIdx  = lines.findIndex(l => SKU_RE.test(l))
    const before  = skuIdx > 0 ? lines.slice(0, skuIdx) : lines
    const nameCands = before.filter(l => !isNoiseLine(l))
    const name    = nameCands[nameCands.length - 1] || sku

    // Quantity: "N ×" pattern or explicit label
    const qtyM = rowText.match(QTY_X_RE) ||
                 rowText.match(/(?:Antal|Mængde|Qty)\s*:?\s*(\d+)/i)
    const quantity = qtyM ? parseInt(qtyM[1]) : 1

    // Price: collect all DKK amounts; last one is usually the line total
    const priceHits = [...rowText.matchAll(PRICE_RE)]
    const net_price = priceHits.length
      ? parsePrice(priceHits[priceHits.length - 1][0])
      : 0

    seen.add(sku)
    items.push({ sku, name: name.slice(0, 200), quantity, net_price })
  }

  // ── Pass 2: text-window based (fallback) ─────────────────────────────────
  if (items.length === 0) {
    const fullText = stripTags(html)
    const hits     = [...fullText.matchAll(SKU_RE_G)]

    for (const hit of hits) {
      const sku = hit[1].toUpperCase()
      if (seen.has(sku)) continue

      const idx    = hit.index
      const before = fullText.slice(Math.max(0, idx - 300), idx)
      const after  = fullText.slice(idx + hit[0].length, idx + hit[0].length + 300)

      // Product name: last non-noise line before SKU
      const beforeLines = before.split('\n').map(l => l.trim())
      const nameCands   = beforeLines.filter(l => !isNoiseLine(l))
      const name        = nameCands[nameCands.length - 1] || sku

      // Quantity
      const qtyM = (before + after).match(QTY_X_RE) ||
                   (before + after).match(/(?:Antal|Mængde|Qty)\s*:?\s*(\d+)/i)
      const quantity = qtyM ? parseInt(qtyM[1]) : 1

      // Price: first price amount found after the SKU
      const priceHits = [...after.matchAll(PRICE_RE)]
      const net_price = priceHits.length ? parsePrice(priceHits[0][0]) : 0

      seen.add(sku)
      items.push({ sku, name: name.slice(0, 200), quantity, net_price })
    }
  }

  return items
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery cost
// ─────────────────────────────────────────────────────────────────────────────

function parseDelivery(html) {
  const text = stripTags(html)
  // Find a line that starts with a delivery label followed by an amount
  const re = /(?:^|\n)\s*(?:Levering|Fragt|Forsendelse|Shipping|Delivery)\s*[:\-]?\s*([\d.,]+\s*(?:DKK|kr\.?)?)/im
  const m  = text.match(re)
  if (!m) return null
  const amount = parsePrice(m[1])
  return amount > 0 ? amount : null
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery address
// ─────────────────────────────────────────────────────────────────────────────

function parseAddress(html) {
  // Find the section that follows a "Leveringsadresse" / "Shipping address" heading
  const re = /(?:Leveringsadresse|Leveringsoplysninger|Shipping\s+address)\s*<\/[^>]+>([\s\S]{0,600}?)(?=<(?:h[1-6]|table)\b)/i
  const m  = html.match(re)
  if (!m) {
    // Fallback: look in plain text
    const text  = stripTags(html)
    const textM = text.match(/(?:Leveringsadresse|Shipping\s+address)\s*\n([\s\S]{0,300}?)(?:\n\n|$)/i)
    if (!textM) return ''
    return textM[1].split('\n').map(l => l.trim()).filter(l => l).join(', ')
  }
  return stripTags(m[1]).split('\n').map(l => l.trim()).filter(l => l).join(', ')
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
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const secret = req.headers['x-cepelo-secret']
  if (secret !== process.env.CEPELO_API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const {
    subject    = '',
    body_html  = '',
    lang       = 'da',
    valid_days = 30,
  } = req.body

  const debug = req.query.debug === '1'

  if (!body_html) return res.status(400).json({ error: 'body_html is required' })

  // ── 1. Parse email content ─────────────────────────────────────────────────
  const subjectData = parseSubject(subject)

  // If subject didn't yield a quote ref, try the body
  if (!subjectData.quote_ref) {
    subjectData.quote_ref = parseQuoteRef(body_html)
  }

  // Also try subject-style markers in the first 200 chars of the body text
  if (!subjectData.recipient_company) {
    const bodyStart = stripTags(body_html).slice(0, 400)
    const dealerM   = bodyStart.match(/FORHANDLER\s*\|[^:]*:\s*(.+?)\s*[-–\n]/i)
    const custM     = bodyStart.match(/SLUTKUNDE\s*\|[^:]*:\s*(.+?)\s*[-–\n]/i)
    if (dealerM) { subjectData.type = 'dealer';   subjectData.recipient_company = dealerM[1].trim() }
    if (custM)   { subjectData.type = 'customer'; subjectData.recipient_company = custM[1].trim() }
  }

  const rawItems = parseLineItems(body_html)
  const delivery = parseDelivery(body_html)
  const address  = parseAddress(body_html)

  if (rawItems.length === 0) {
    return res.status(422).json({
      error:   'No line items with SKUs found in email body',
      hint:    'Ensure the email contains "SKU: XXXXX" for each product',
      subject: subjectData,
      preview: stripTags(body_html).slice(0, 600),
    })
  }

  // ── 2. Shopify enrichment for all SKUs (parallel) ─────────────────────────
  const enriched = await Promise.all(
    rawItems.map(async item => {
      let shopify = null
      try {
        shopify = await fetchProductBySku(item.sku)
        if (!shopify) console.warn(`[parse-email] SKU ${item.sku} not found in Shopify`)
      } catch (e) {
        console.warn(`[parse-email] Shopify fetch error for ${item.sku}:`, e.message)
      }
      return { ...item, shopify }
    })
  )

  // ── 3. Build main_product + line_items ────────────────────────────────────
  const [first, ...rest] = enriched

  function buildProduct(item) {
    const s = item.shopify
    return {
      // Shopify data as base (when available)
      ...(s && {
        name:               s.name,
        description:        s.description,
        description_html:   s.description_html,
        image_url:          s.image_url,
        images:             s.images,
        gross_price:        s.gross_price,
        currency:           s.currency,
        vendor:             s.vendor,
        product_type:       s.product_type,
        shopify_handle:     s.handle,
        shopify_product_id: s.shopify_product_id,
      }),
      // Fields from the email (net price from email is the agreed/quoted price)
      sku:       item.sku,
      name:      s?.name || item.name,
      quantity:  item.quantity,
      net_price: item.net_price,   // email price = what was quoted to the customer
    }
  }

  const main_product = buildProduct(first)

  const line_items = rest.map(buildProduct)

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

  // ── 4. Available accessories ───────────────────────────────────────────────
  const mainSku           = first.sku
  const staticAccessories = getAccessoriesForSku(mainSku)

  let shopifyRecs = []
  if (first.shopify?.shopify_product_id) {
    try {
      shopifyRecs = await fetchProductRecommendations(first.shopify.shopify_product_id)
    } catch (e) {
      console.warn('[parse-email] Recommendations error:', e.message)
    }
  }

  const seenSkus   = new Set(staticAccessories.map(a => a.sku))
  const uniqueRecs = shopifyRecs.filter(r => !seenSkus.has(r.sku))
  const available_accessories = [...staticAccessories, ...uniqueRecs]

  // ── 5. Debug mode – return parsed data without writing anything ────────────
  const parsedSummary = {
    type:               subjectData.type,
    quote_ref:          subjectData.quote_ref,
    recipient_company:  subjectData.recipient_company,
    delivery,
    address,
    items: enriched.map(i => ({
      sku:         i.sku,
      name:        i.shopify?.name || i.name,
      quantity:    i.quantity,
      net_price:   i.net_price,
      shopify_ok:  !!i.shopify,
    })),
    accessories_count:      available_accessories.length,
    recommendations_count:  uniqueRecs.length,
  }

  if (debug) {
    return res.status(200).json({ debug: true, parsed: parsedSummary, main_product, line_items })
  }

  // ── 6. Insert quote into Supabase ──────────────────────────────────────────
  const token      = randomBytes(16).toString('hex')
  const validUntil = new Date()
  validUntil.setDate(validUntil.getDate() + valid_days)

  const { error } = await adminClient.from('quotes').insert({
    token,
    shopify_order_id:      subjectData.quote_ref || 'PARSED',
    type:                  subjectData.type,
    lang,
    category:              'other',
    status:                'sent',
    sender_name:           '',
    sender_email:          process.env.DEFAULT_SENDER_EMAIL || '',
    sender_phone:          '',
    recipient_name:        '',
    recipient_company:     subjectData.recipient_company || '',
    recipient_email:       '',
    recipient_phone:       '',
    dealer_name:           '',
    dealer_email:          '',
    main_product,
    line_items,
    available_accessories,
    notes:                 address ? `Leveringsadresse: ${address}` : '',
    valid_until:           validUntil.toISOString().split('T')[0],
  })

  if (error) {
    console.error('[parse-email] Supabase insert error:', error)
    return res.status(500).json({ error: `Supabase error: ${error.message}` })
  }

  const baseUrl  = process.env.NEXT_PUBLIC_BASE_URL
  const quoteUrl = `${baseUrl}/quote/${token}`

  return res.status(200).json({
    success:              true,
    token,
    quote_url:            quoteUrl,
    customer_url:         `${quoteUrl}?view=customer`,
    parsed:               parsedSummary,
  })
}
