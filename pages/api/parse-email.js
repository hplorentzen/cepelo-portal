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
//
// Uses an HTML-context-window approach: locate each "SKU: XXX" occurrence in
// the raw HTML, grab ±800 chars of surrounding HTML, strip it to text, then
// extract name / quantity / price from that text block.
//
// This is more robust than parsing <tr> elements because Shopify emails use
// nested tables — the SKU lives in an inner <td> while the price is in a
// sibling <td> of the outer <tr>. Simple <tr> matching only captures the inner
// row and misses the price.  Context-window grabs both.
// ─────────────────────────────────────────────────────────────────────────────

// Matches "SKU: CEP028" or "Varenr.: IT25" etc.
const SKU_RE_G = /\b(?:SKU|Varenr\.?)\s*:?\s*([A-Z][A-Z0-9\-_]{2,20})\b/gi
// DKK price in Danish or English format
const PRICE_RE = /([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)\s*(?:DKK|kr\.?)/gi
// "N ×" quantity that Shopify puts before unit prices
const QTY_X_RE = /(\d+)\s*[×xX]\s*[\d.,]/

/** True for lines that are structural noise, not product names */
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
  const seen  = new Set()

  // For each SKU occurrence in the raw HTML, grab ±800 chars of context.
  // This captures both the product-name cell (before the SKU) and the price
  // cell (sibling <td> after), regardless of nesting depth.
  const skuHits = [...html.matchAll(SKU_RE_G)]

  for (const hit of skuHits) {
    const sku = hit[1].toUpperCase()
    if (seen.has(sku)) continue

    const ctxStart   = Math.max(0, hit.index - 600)
    const ctxEnd     = Math.min(html.length, hit.index + 600)
    const ctxText    = stripTags(html.slice(ctxStart, ctxEnd))
    const beforeText = stripTags(html.slice(ctxStart, hit.index))

    // ── Product name ────────────────────────────────────────────────────────
    const beforeLines = beforeText.split('\n').map(l => l.trim())
    const nameCands   = beforeLines.filter(l => !isNoiseLine(l))
    const name        = nameCands[nameCands.length - 1] || sku

    // ── Quantity ─────────────────────────────────────────────────────────────
    const qtyM    = ctxText.match(QTY_X_RE) ||
                    ctxText.match(/(?:Antal|Mængde|Qty)\s*:?\s*(\d+)/i)
    const quantity = qtyM ? parseInt(qtyM[1]) : 1

    // ── Price ────────────────────────────────────────────────────────────────
    // Collect all DKK amounts in the context; last one is usually the line total.
    // Filter out trivially small amounts (< 10 DKK) to avoid qty or year numbers.
    const priceHits   = [...ctxText.matchAll(PRICE_RE)]
    const validPrices = priceHits.filter(p => parsePrice(p[0]) >= 10)
    const net_price   = validPrices.length
      ? parsePrice(validPrices[validPrices.length - 1][0])
      : 0

    seen.add(sku)
    items.push({ sku, name: name.slice(0, 200), quantity, net_price })
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
  // Convert to plain text, find the "Leveringsadresse" header line,
  // then collect the following lines until a section boundary or 6 lines max.
  // Line-index approach avoids the double-newline trap that breaks regex.
  const text  = stripTags(html)
  const lines = text.split('\n').map(l => l.trim())

  const headerIdx = lines.findIndex(l =>
    /^(?:Leveringsadresse|Leveringsoplysninger|Shipping\s+address)\s*$/i.test(l)
  )
  if (headerIdx === -1) return ''

  const STOP_RE = /^(?:Subtotal|Levering|Fragt|I\s+alt|Total|Moms|Skat|Faktura|Betalings)/i

  const addressLines = []
  for (let i = headerIdx + 1; i < lines.length && addressLines.length < 7; i++) {
    const l = lines[i]
    if (!l)              continue          // skip blank lines but keep going
    if (STOP_RE.test(l)) break             // hit totals section — stop
    addressLines.push(l)
  }

  return addressLines.join(', ')
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
