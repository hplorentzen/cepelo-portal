// pages/api/parse-email.js
//
// Parses a Shopify draft-order notification email, enriches each line item
// with Shopify product data, and creates a quote in Supabase.
//
// POST /api/parse-email
// Headers : x-cepelo-secret: <CEPELO_API_SECRET>
// Body (JSON):
//   subject    – email subject line (used to detect type + customer name)
//   body_html  – raw HTML of the notification email (required; "html" also accepted)
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
import { fetchProductBySku } from '../../lib/shopify'
import { getAccessoriesForSku } from '../../lib/accessories'
import { sendEmail, sellerNotificationEmail } from '../../lib/email'

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
  // "44.995" / "1.135.000" – thousands-separated integer (one or more groups)
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

// Matches "SKU: CEP028", "Varenr.: IT25", "Varenummer: AUT100003195_1" etc.
// SKU char class starts with [A-Z0-9] (some IDs start with a digit) and
// allows up to 35 chars to cover long identifiers like "AUT100003195_1".
const SKU_RE_G = /\b(?:SKU|Varenr\.?|Varenummer)\s*:?\s*([A-Z0-9][A-Z0-9\-_]{2,35})\b/gi
// DKK / kr price in Danish or English format
const PRICE_RE = /([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)\s*(?:DKK|kr\.?)/gi
// "N × price" — qty is the number BEFORE × (standard Shopify inline)
const QTY_BEFORE_X_RE = /(\d+)\s*[×xX]\s*[\d.,]/
// "name × qty\n" — qty is the number AFTER × at end of a line
//   e.g. "AUTEL EV-pakke til Ultra + 909 × 1\nVarenummer: ..."
const QTY_AFTER_X_RE  = /[×xX]\s*(\d{1,4})\s*$/m

/** True for lines that are structural noise, not product names */
function isNoiseLine(line) {
  return (
    line.length < 3 ||
    /^\s*$/.test(line) ||
    /^(?:SKU|Varenr|Varenummer|Art\.?nr)/i.test(line) ||
    /^(?:Antal|Mængde|Qty|Quantity)\s*:/i.test(line) ||
    /^(?:Subtotal|Levering|Fragt|Forsendelse|Shipping|I\s+alt|Total|Moms|Skat)\b/i.test(line) ||
    /^[\d.,\s]+(?:DKK|kr\.?)?$/i.test(line) ||
    // CSS garbage: leaked from a style attribute when the context window starts
    // mid-tag (e.g. the slice starts inside 'font-family:-apple-system,Blink…')
    /font-family|font-size|BlinkMacSystemFont|Helvetica\s*Neue|sans-serif\s*[;,]|color\s*:#|padding\s*:/i.test(line)
  )
}

// debugCollector is optional; when provided it is populated with per-SKU price
// strategy details and per-hit Pass 2 skip reasons for the ?debug=1 endpoint.
function parseLineItems(html, debugCollector = null) {
  const items = []
  const seen  = new Set()

  // For each SKU occurrence in the raw HTML, grab ±600/+1000 chars of context.
  // This captures both the product-name cell (before the SKU) and the price
  // cell (sibling <td> after), regardless of nesting depth.
  const skuHits       = [...html.matchAll(SKU_RE_G)]
  const claimedRanges = []  // HTML char ranges "owned" by SKU items (used in Pass 2)
  // Raw hit positions used in Pass 2 to detect bundle sub-items
  const skuIndices    = skuHits.map(h => h.index)

  for (const hit of skuHits) {
    const sku = hit[1].toUpperCase()
    if (seen.has(sku)) continue

    // Record the context window so Pass 2 won't re-capture this item's price.
    // Forward claim is 700 chars (not 1000) so manual items just after the last
    // SKU row are not accidentally swallowed; rawAfter still searches 1000 chars.
    claimedRanges.push([Math.max(0, hit.index - 600), hit.index + 700])

    // ── Text before and after the SKU label ────────────────────────────────
    const beforeHtml = html.slice(Math.max(0, hit.index - 600), hit.index)
                           .replace(/^[^<]*>/, '')
    const beforeText = stripTags(beforeHtml)
    const rawAfter      = html.slice(hit.index + hit[0].length,
                                     Math.min(html.length, hit.index + 1000))
    // Remove strikethrough elements (original/crossed-out prices) before text
    // extraction so that e.g. <s>160.000,00 kr</s> never enters PRICE_RE.
    const rawAfterClean = rawAfter
      .replace(/<(?:s|del|strike)\b[^>]*>[\s\S]*?<\/(?:s|del|strike)>/gi, ' ')
    const afterText     = stripTags(rawAfterClean)

    // Truncate afterText at "Subtotal / I alt / Total" to avoid grand-total bleed
    const stopIdx   = afterText.search(/\b(?:Subtotal|I\s+alt|Total)\b/i)
    const priceZone = stopIdx > 0 ? afterText.slice(0, stopIdx) : afterText

    // ── Product name (last meaningful line before the SKU label) ───────────
    const beforeLines = beforeText.split('\n').map(l => l.trim())
    const nameCands   = beforeLines.filter(l => !isNoiseLine(l))
    const rawName     = nameCands[nameCands.length - 1] || sku
    // Strip trailing "× qty" suffix — some templates embed qty in the title line
    const name = rawName.replace(/\s*[×xX]\s*\d+\s*$/, '').trim().slice(0, 200)

    // ── Quantity ──────────────────────────────────────────────────────────────
    // Priority 1: "name × qty" at end of a line in the before-text
    // Priority 2: "qty × price" in the after-text (standard Shopify inline)
    // Priority 3: "Antal: N" label
    // Priority 4: standalone integer on its own line (bare <td>N</td>)
    const lastBeforeLines = beforeLines.slice(-5).join('\n')
    const qtyAfterX  = lastBeforeLines.match(QTY_AFTER_X_RE)
    const qtyBeforeX = priceZone.match(QTY_BEFORE_X_RE)
    const qtyLabel   = priceZone.match(/(?:Antal|Mængde|Qty)\s*:?\s*(\d+)/i)
    let quantity = 1
    if (qtyAfterX) {
      quantity = parseInt(qtyAfterX[1])
    } else if (qtyBeforeX) {
      quantity = parseInt(qtyBeforeX[1])
    } else if (qtyLabel) {
      quantity = parseInt(qtyLabel[1])
    } else {
      const standaloneQty = priceZone
        .split('\n').map(l => l.trim())
        .find(l => /^\d{1,3}$/.test(l) && parseInt(l) >= 1 && parseInt(l) <= 999)
      if (standaloneQty) quantity = parseInt(standaloneQty)
    }

    // ── Price ──────────────────────────────────────────────────────────────────
    let net_price  = 0
    let dbgStrat   = 'none'
    let dbgS1Match = null
    let dbgS2List  = null

    // Strategy 1 (primary): Shopify's "order-listitem-price" class element always
    // holds the actual charged price. Handles direct email and Outlook x_/x_x_
    // prefixed variants ("x_x_order-list__item-price" etc).
    const shopifyPriceRe = /class="[^"]*(?:order-listitem-price|order-list[^"]{0,10}item-price)[^"]*"[^>]*>([\s\S]{1,300}?)(?=<\/[a-zA-Z])/i
    const itemPriceHit   = rawAfterClean.match(shopifyPriceRe)
    if (itemPriceHit) {
      const content = stripTags(itemPriceHit[1])
      dbgS1Match    = content.slice(0, 80)
      const pm      = content.match(/([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)\s*(?:DKK|kr\.?)/i)
      if (pm) {
        net_price = parsePrice(pm[0])
        dbgStrat  = 'strategy1_class'
      }
    }

    // Strategy 2 (fallback): scan priceZone text, skip discount amounts.
    // When a campaign/discount label is detected Shopify always orders prices as
    // [original → charged], so take the LAST valid price (the charged one).
    // Without a discount label a single price is expected; take the first.
    if (!net_price) {
      const hasDiscount = /TILPASSET\s+RABAT|KAMPAGNE\s*\(|RABAT\s*\(/i.test(priceZone)
      const priceHits   = [...priceZone.matchAll(PRICE_RE)]
      const validPrices = priceHits.filter(p => {
        if (parsePrice(p[0]) < 10) return false
        // Skip amounts immediately preceded by '-', '−', or '(' (discount labels)
        const preceding = priceZone.slice(Math.max(0, p.index - 3), p.index)
        return !/[-−(]/.test(preceding)
      })
      if (debugCollector) dbgS2List = validPrices.map(p => parsePrice(p[0]))
      const candidate = (hasDiscount && validPrices.length > 1)
        ? validPrices[validPrices.length - 1]   // charged price is LAST when discount present
        : validPrices[0]
      if (candidate) {
        net_price = parsePrice(candidate[0])
        dbgStrat  = hasDiscount && validPrices.length > 1
          ? 'strategy2_last_discount'
          : 'strategy2_first'
      }
    }

    if (debugCollector) {
      debugCollector.priceStrategies.push({
        sku,
        strategy1_matched:   !!itemPriceHit,
        strategy1_content:   dbgS1Match,
        strategy2_prices:    dbgS2List,
        has_discount_label:  /TILPASSET\s+RABAT|KAMPAGNE\s*\(|RABAT\s*\(/i.test(priceZone),
        price_zone_preview:  priceZone.slice(0, 300).replace(/\s+/g, ' '),
        strategy_used:       dbgStrat,
        net_price,
      })
    }

    seen.add(sku)
    items.push({ sku, name: name.slice(0, 200), quantity, net_price })
  }

  // ── Pass 2: manual lines (no SKU label) ───────────────────────────────────
  // Scan for DKK prices that don't fall inside any SKU item's context window.
  // These are manually-added order lines: "Montering", "Diverse olie" etc.
  // Skip "Rabat" / savings lines — handled by parseDiscounts().
  const MANUAL_SKIP_RE = /^(?:Subtotal|Levering|Fragt|Forsendelse|Shipping|I\s+alt|Total\b|Moms|Skat|Ordrenummer|Betaling|Faktura|FORHANDLER|SLUTKUNDE|Tilbud\b|Draft\b|Betalings|Rabat\b|Du\s+har\s+sparet)/i
  const seenManualNames = new Set()

  for (const pm of html.matchAll(PRICE_RE)) {
    const price = parsePrice(pm[0])
    if (price < 10) continue

    // Skip if this price falls inside any SKU item's claimed context window
    const claimedBy = claimedRanges.filter(([a, b]) => pm.index >= a && pm.index <= b)
    if (claimedBy.length) {
      if (debugCollector) debugCollector.pass2.push({
        price, pos: pm.index, skip: 'in_claimed_range',
        claimed_by: claimedBy.map(([a, b]) => `[${a}–${b}]`).join(', '),
        match: pm[0],
      })
      continue
    }

    // Get surrounding text (500 HTML chars before this price)
    const beforeText = stripTags(
      html.slice(Math.max(0, pm.index - 500), pm.index).replace(/^[^<]*>/, '')
    )
    const lines = beforeText.split('\n').map(l => l.trim())

    // Skip if we're in a totals section
    const tailText = lines.slice(-4).join(' ')
    if (/(?:Subtotal|I\s+alt|Total\b|Moms\b|Skat\b)/i.test(tailText)) {
      if (debugCollector) debugCollector.pass2.push({
        price, pos: pm.index, skip: 'totals_section',
        context: tailText.slice(0, 120),
      })
      continue
    }

    // Last meaningful, non-noise, non-totals line = product name
    const nameCands = lines.filter(l =>
      !isNoiseLine(l) && !MANUAL_SKIP_RE.test(l) && l.length < 200
    )
    if (!nameCands.length) {
      if (debugCollector) debugCollector.pass2.push({
        price, pos: pm.index, skip: 'no_name_candidate',
        last_lines: lines.slice(-5).join(' | ').slice(0, 200),
      })
      continue
    }

    const name    = nameCands[nameCands.length - 1].slice(0, 200)
    const nameKey = name.toLowerCase()

    // Skip Shopify bundle sub-items: child rows that appear under a main SKU row
    // in the email. They have a Shopify "× N" quantity suffix in their name and
    // sit within 2000 HTML chars of a known SKU hit.
    // Examples: "IA900 Basis-pakke × 1", "Autel Rideheight targets × 1"
    const isBundleSubItem =
      /[×xX]\s*\d+\s*$/.test(name) &&
      skuIndices.some(idx => pm.index > idx && pm.index < idx + 2000)
    if (isBundleSubItem) {
      if (debugCollector) debugCollector.pass2.push({ price, pos: pm.index, skip: 'bundle_sub_item', name })
      continue
    }

    if (seenManualNames.has(nameKey)) {
      if (debugCollector) debugCollector.pass2.push({ price, pos: pm.index, skip: 'duplicate_name', name })
      continue
    }
    seenManualNames.add(nameKey)

    if (debugCollector) debugCollector.pass2.push({ price, pos: pm.index, skip: null, name, included: true })

    items.push({
      sku:         null,
      name,
      quantity:    1,
      net_price:   price,
      gross_price: price,
      type:        'manual',
    })
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
// Discounts  –  "Rabat (CODE): X DKK" in totals, "Du har sparet X kr"
// ─────────────────────────────────────────────────────────────────────────────

function parseDiscounts(html) {
  const text        = stripTags(html)
  const lines       = text.split('\n').map(l => l.trim()).filter(Boolean)
  const discounts   = []
  const seenAmounts = new Set()        // prevents double-counting same amount

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // ── "Du har sparet X kr [på denne ordre]" ──────────────────────────────
    const savedM = line.match(/du\s+har\s+sparet\s+([\d.,]+\s*(?:DKK|kr\.?))/i)
    if (savedM) {
      const amount = parsePrice(savedM[1])
      if (amount > 0 && !seenAmounts.has(amount)) {
        seenAmounts.add(amount)
        discounts.push({ sku: null, name: 'Besparelse', quantity: 1,
          net_price: -amount, gross_price: -amount, type: 'discount' })
      }
      continue
    }

    // ── "Rabat" / "Rabat (CODE)" in totals section ─────────────────────────
    if (/^Rabat\b/i.test(line)) {
      // Price may be on the same line or the next
      const context = [line, lines[i + 1] || ''].join(' ')
      const priceM  = context.match(/([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)\s*(?:DKK|kr\.?)/i)
      if (priceM) {
        const amount = parsePrice(priceM[1])
        if (amount > 0 && !seenAmounts.has(amount)) {
          seenAmounts.add(amount)
          const nameM = line.match(/^(Rabat(?:\s*\([^)]*\))?)/i)
          discounts.push({ sku: null, name: (nameM && nameM[1]) || 'Rabat',
            quantity: 1, net_price: -amount, gross_price: -amount, type: 'discount' })
        }
      }
    }
  }

  return discounts
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery address
// ─────────────────────────────────────────────────────────────────────────────

function parseAddress(html) {
  // Convert to plain text, find the "Leveringsadresse" header line,
  // then collect the following lines until a section boundary or 6 lines max.
  // Line-index approach avoids the double-newline trap that breaks regex.
  //
  // Returns { company, address } where:
  //   company – first line of the address block (usually the dealer company name)
  //   address – all lines joined with ", " (full delivery address)
  const text  = stripTags(html)
  const lines = text.split('\n').map(l => l.trim())

  const headerIdx = lines.findIndex(l =>
    /^(?:Leveringsadresse|Leveringsoplysninger|Shipping\s+address)\s*$/i.test(l)
  )
  if (headerIdx === -1) return { company: '', address: '' }

  const STOP_RE = /^(?:Subtotal|Levering|Fragt|I\s+alt|Total|Moms|Skat|Faktura|Betalings)/i

  const addressLines = []
  for (let i = headerIdx + 1; i < lines.length && addressLines.length < 7; i++) {
    const l = lines[i]
    if (!l)              continue          // skip blank lines but keep going
    if (STOP_RE.test(l)) break             // hit totals section — stop
    addressLines.push(l)
  }

  // In Shopify emails the first line of the delivery address is typically
  // the company name (for B2B/dealer orders).
  const company = addressLines[0] || ''
  return { company, address: addressLines.join(', ') }
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
    subject      = '',
    body_html,
    html: html_field,
    lang         = 'da',
    valid_days   = 30,
    seller_email = '',   // Power Automate: @{triggerOutputs()?['body/from']}
  } = req.body

  const debug = req.query.debug === '1'

  // ── Normalise HTML before any parsing ────────────────────────────────────
  // 1. &nbsp; / &#160; → space: prevents "Varenummer:&nbsp;AUT100003960" from
  //    breaking the SKU regex whose \s* cannot match HTML entity literals.
  // 2. Swap "DKK 135.000,00" → "135.000,00 DKK": Shopify sometimes puts the
  //    currency symbol BEFORE the number; PRICE_RE expects it after.
  const emailHtml = (body_html || html_field || '')
    .replace(/&nbsp;/g,  ' ')
    .replace(/&#160;/g,  ' ')
    .replace(
      /(DKK|kr\.?)\s+([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)/gi,
      '$2 $1'
    )

  // Parse "Name <email>" or bare "email" from the From header value
  // Power Automate sends body/from as the full RFC 5322 address string.
  const fromMatch    = seller_email.match(/^(.+?)\s*<([^>]+)>/)
  const sellerName   = fromMatch ? fromMatch[1].trim() : ''
  const sellerAddr   = fromMatch ? fromMatch[2].trim() : seller_email.trim()

  if (!emailHtml) return res.status(400).json({ error: 'body_html (or html) is required' })

  // ── 1. Parse email content ─────────────────────────────────────────────────
  const subjectData = parseSubject(subject)

  // If subject didn't yield a quote ref, try the body
  if (!subjectData.quote_ref) {
    subjectData.quote_ref = parseQuoteRef(emailHtml)
  }

  // Also try subject-style markers in the first 200 chars of the body text
  if (!subjectData.recipient_company) {
    const bodyStart = stripTags(emailHtml).slice(0, 400)
    const dealerM   = bodyStart.match(/FORHANDLER\s*\|[^:]*:\s*(.+?)\s*[-–\n]/i)
    const custM     = bodyStart.match(/SLUTKUNDE\s*\|[^:]*:\s*(.+?)\s*[-–\n]/i)
    if (dealerM) { subjectData.type = 'dealer';   subjectData.recipient_company = dealerM[1].trim() }
    if (custM)   { subjectData.type = 'customer'; subjectData.recipient_company = custM[1].trim() }
  }

  const debugCollector = debug ? { priceStrategies: [], pass2: [] } : null
  const rawItems       = parseLineItems(emailHtml, debugCollector)
  const rawSkuItems    = rawItems.filter(i => i.type !== 'manual')
  const rawManualItems = rawItems.filter(i => i.type === 'manual')
  const delivery       = parseDelivery(emailHtml)
  const address        = parseAddress(emailHtml)

  if (rawSkuItems.length === 0) {
    return res.status(422).json({
      error:   'No line items with SKUs found in email body',
      hint:    'Ensure the email contains "SKU: XXXXX" for each product',
      subject: subjectData,
      preview: stripTags(emailHtml).slice(0, 600),
    })
  }

  // ── 2. Shopify enrichment for SKU items only (manual lines skip Shopify) ──
  const enriched = await Promise.all(
    rawSkuItems.map(async item => {
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
  const isCustomerQuote  = subjectData.type === 'customer'

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
      //   dealer   → email price = net (dealer cost); Shopify gross = suggested retail
      //   customer → email price IS the gross (agreed customer price); no net concept
      net_price:   isCustomerQuote ? 0            : item.net_price,
      gross_price: isCustomerQuote ? item.net_price : (s?.gross_price || 0),
    }
  }

  const main_product = buildProduct(first)

  const line_items = rest.map(buildProduct)

  // Append manual lines verbatim (no Shopify enrichment; prices are fixed)
  rawManualItems.forEach(item => line_items.push({
    sku:         null,
    name:        item.name,
    quantity:    1,
    net_price:   isCustomerQuote ? 0               : item.net_price,
    gross_price: isCustomerQuote ? item.net_price   : item.gross_price,
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

  // Discount lines ("Rabat (CODE)", "Du har sparet X kr")
  const discounts = parseDiscounts(emailHtml)
  discounts.forEach(d => line_items.push(d))

  // ── 4. Available accessories (static only — Shopify recs are too unpredictable) ───
  const mainSku              = first.sku
  const available_accessories = getAccessoriesForSku(mainSku)

  // ── 5. Debug mode – return parsed data without writing anything ────────────
  const parsedSummary = {
    type:               subjectData.type,
    quote_ref:          subjectData.quote_ref,
    recipient_company:  subjectData.recipient_company,
    dealer_name:        address.company,
    delivery,
    address:            address.address,
    items: [
      ...enriched.map(i => ({
        sku:         i.sku,
        name:        i.shopify?.name || i.name,
        quantity:    i.quantity,
        net_price:   i.net_price,
        shopify_ok:  !!i.shopify,
      })),
      ...rawManualItems.map(i => ({
        sku:         null,
        name:        i.name,
        quantity:    i.quantity,
        net_price:   i.net_price,
        type:        'manual',
      })),
      ...discounts.map(d => ({
        sku:        null,
        name:       d.name,
        net_price:  d.net_price,
        type:       'discount',
      })),
    ],
    accessories_count: available_accessories.length,
    discount_count:    discounts.length,
  }

  if (debug) {
    // Raw debug mode – return everything including pre-enrichment prices.
    // sku_regex_hits: every occurrence the SKU regex found (before dedup/seen check)
    // — lets you verify that "&nbsp;" normalisation fixed missing SKUs.
    const skuRegexHits = [...emailHtml.matchAll(
      /\b(?:SKU|Varenr\.?|Varenummer)\s*:?\s*([A-Z0-9][A-Z0-9\-_]{2,35})\b/gi
    )].map(m => ({
      sku:     m[1].toUpperCase(),
      fullMatch: m[0],
      index:   m.index,
      context: emailHtml.slice(Math.max(0, m.index - 60), m.index + 80).replace(/\s+/g, ' '),
    }))

    return res.status(200).json({
      debug:       true,
      parsed:      parsedSummary,
      main_product,
      line_items,
      raw: {
        sku_regex_hits:   skuRegexHits,
        // price_strategies: per-SKU record of which strategy fired, what it saw,
        //   and why Strategy 1 (class-based) matched or didn't.
        price_strategies: debugCollector.priceStrategies,
        // pass2_hits: every PRICE_RE match in Pass 2, with skip reason or name.
        //   "in_claimed_range" hits reveal whether manual items fall inside a
        //   SKU item's context window (most common cause of missing manual lines).
        pass2_hits:       debugCollector.pass2,
        sku_items:        rawSkuItems.map(i => ({
          sku: i.sku, name: i.name, quantity: i.quantity, net_price: i.net_price,
        })),
        manual_items:     rawManualItems,
        discounts,
        delivery,
        subject:          subjectData,
        address,
        email_preview:    stripTags(emailHtml).slice(0, 2000),
      },
    })
  }

  // ── 6. Insert DRAFT quote into Supabase ───────────────────────────────────
  // The quote starts as a draft. The CEPELO seller fills in dealer + customer
  // details via /seller/[draft_token], which then flips status → 'sent' and
  // emails the dealer.
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

  const baseUrl        = process.env.NEXT_PUBLIC_BASE_URL
  const sellerFormUrl  = `${baseUrl}/seller/${draft_token}`

  // ── 7. Notify the CEPELO seller ────────────────────────────────────────────
  // Use the extracted sender address if available, fall back to DEFAULT_SENDER_EMAIL
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
      // Non-fatal – the quote was created; just log
      console.warn('[parse-email] Seller notification email failed:', emailErr.message)
    }
  }

  return res.status(200).json({
    success:              true,
    draft_token,
    seller_form_url:      sellerFormUrl,
    seller_email:         sellerAddr || null,
    parsed:               parsedSummary,
  })
}

// Named exports used by /api/test-parse
export { parseLineItems, parseDelivery, parseAddress, parseSubject, parseDiscounts, stripTags, parsePrice }
