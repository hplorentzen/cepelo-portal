// pages/api/parse-email.js
//
// Receives a Shopify draft-order notification from Power Automate, builds a
// quote from the order data, enriches it with Shopify Storefront product info,
// and persists it in Supabase.
//
// Primary data path  (when SHOPIFY_ADMIN_TOKEN is valid):
//   subject → order ref → Shopify Admin API draft order → buildItemsFromDraftOrder
//
// Fallback data path (when Admin API returns 401 or token not configured):
//   body_html → HTML context-window parsing → buildItemsFromEmail
//
// POST /api/parse-email
// Headers : x-cepelo-secret: <CEPELO_API_SECRET>
// Body (JSON):
//   subject      – email subject (order ref + dealer/customer name)
//   body_html    – raw email HTML (required for fallback path; "html" alias ok)
//   lang         – "da" | "no" | "is"  (default "da")
//   valid_days   – quote validity in days (default 30)
//   seller_email – RFC 5322 From header from Power Automate
//
// Query params:
//   ?debug=1  – parse without writing to Supabase; returns full debug payload
//
// Subject formats:
//   "FORHANDLER | Slutkunde: Greve Autoværksted - Tilbud #D4735"
//     → type=dealer,   recipient_company="Greve Autoværksted", quote_ref="#D4735"
//   "SLUTKUNDE | Kunde: Hans Nielsen - Tilbud #D4735"
//     → type=customer, recipient_company="Hans Nielsen",       quote_ref="#D4735"

import { createClient } from '@supabase/supabase-js'
import { randomBytes }  from 'crypto'
import { fetchProductBySku, fetchDraftOrderByRef, fetchAccessoriesFromMetafields } from '../../lib/shopify'
import { sendEmail, sellerNotificationEmail } from '../../lib/email'
import { getSellerByEmail } from '../../lib/sellers'

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
// ── FALLBACK: HTML email parsing ─────────────────────────────────────────────
//
// Used when the Shopify Admin API token is not configured or returns 401.
// Extracts line items by locating each "Varenummer: SKU" anchor in the raw
// HTML, grabbing ±600/+1000 chars of surrounding HTML as a context window,
// and extracting name / quantity / price from that text block.
// ─────────────────────────────────────────────────────────────────────────────

// Matches "SKU: CEP028", "Varenr.: IT25", "Varenummer: AUT100003195_1" etc.
const SKU_RE_G = /\b(?:SKU|Varenr\.?|Varenummer)\s*:?\s*([A-Z0-9][A-Z0-9\-_]{2,35})\b/gi
// DKK / kr price in Danish or English format
const PRICE_RE = /([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)\s*(?:DKK|kr\.?)/gi
// "N × price" — qty is the number BEFORE × (standard Shopify inline)
const QTY_BEFORE_X_RE = /(\d+)\s*[×xX]\s*[\d.,]/
// "name × qty\n" — qty is the number AFTER × at end of a line
const QTY_AFTER_X_RE  = /[×xX]\s*(\d{1,4})\s*$/m

function isNoiseLine(line) {
  return (
    line.length < 3 ||
    /^\s*$/.test(line) ||
    /^(?:SKU|Varenr|Varenummer|Art\.?nr)/i.test(line) ||
    /^(?:Antal|Mængde|Qty|Quantity)\s*:/i.test(line) ||
    /^(?:Subtotal|Levering|Fragt|Forsendelse|Shipping|I\s+alt|Total|Moms|Skat)\b/i.test(line) ||
    /^[\d.,\s]+(?:DKK|kr\.?)?$/i.test(line) ||
    /font-family|font-size|BlinkMacSystemFont|Helvetica\s*Neue|sans-serif\s*[;,]|color\s*:#|padding\s*:/i.test(line)
  )
}

// debugCollector is optional; when provided it is populated with per-SKU price
// strategy details and per-hit Pass 2 skip reasons for the ?debug=1 endpoint.
function parseLineItems(html, debugCollector = null) {
  const items = []
  const seen  = new Set()

  const skuHits       = [...html.matchAll(SKU_RE_G)]
  const claimedRanges = []
  const skuIndices    = skuHits.map(h => h.index)

  for (const hit of skuHits) {
    const sku = hit[1].toUpperCase()
    if (seen.has(sku)) continue

    // Forward claim is 700 chars so manual items just after the last SKU row
    // are not accidentally swallowed; rawAfter still searches 1000 chars.
    claimedRanges.push([Math.max(0, hit.index - 600), hit.index + 700])

    const beforeHtml = html.slice(Math.max(0, hit.index - 600), hit.index)
                           .replace(/^[^<]*>/, '')
    const beforeText = stripTags(beforeHtml)
    const rawAfter      = html.slice(hit.index + hit[0].length,
                                     Math.min(html.length, hit.index + 1000))
    // Remove strikethrough elements (crossed-out/original prices) before extracting
    const rawAfterClean = rawAfter
      .replace(/<(?:s|del|strike)\b[^>]*>[\s\S]*?<\/(?:s|del|strike)>/gi, ' ')
    const afterText     = stripTags(rawAfterClean)

    const stopIdx   = afterText.search(/\b(?:Subtotal|I\s+alt|Total)\b/i)
    const priceZone = stopIdx > 0 ? afterText.slice(0, stopIdx) : afterText

    // Product name – last meaningful line before the SKU label
    const beforeLines = beforeText.split('\n').map(l => l.trim())
    const nameCands   = beforeLines.filter(l => !isNoiseLine(l))
    const rawName     = nameCands[nameCands.length - 1] || sku
    const name = rawName.replace(/\s*[×xX]\s*\d+\s*$/, '').trim().slice(0, 200)

    // Quantity (priority: × qty at end of name line > qty × price > Antal: N > standalone int)
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

    // Price – Strategy 1: Shopify's "order-listitem-price" CSS class (direct + Outlook x_ prefix)
    let net_price  = 0
    let dbgStrat   = 'none'
    let dbgS1Match = null
    let dbgS2List  = null

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

    // Price – Strategy 2: scan priceZone text; take LAST price when discount label present
    if (!net_price) {
      const hasDiscount = /TILPASSET\s+RABAT|KAMPAGNE\s*\(|RABAT\s*\(/i.test(priceZone)
      const priceHits   = [...priceZone.matchAll(PRICE_RE)]
      const validPrices = priceHits.filter(p => {
        if (parsePrice(p[0]) < 10) return false
        const preceding = priceZone.slice(Math.max(0, p.index - 3), p.index)
        return !/[-−(]/.test(preceding)
      })
      if (debugCollector) dbgS2List = validPrices.map(p => parsePrice(p[0]))
      const candidate = (hasDiscount && validPrices.length > 1)
        ? validPrices[validPrices.length - 1]
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
        strategy1_matched:  !!itemPriceHit,
        strategy1_content:  dbgS1Match,
        strategy2_prices:   dbgS2List,
        has_discount_label: /TILPASSET\s+RABAT|KAMPAGNE\s*\(|RABAT\s*\(/i.test(priceZone),
        price_zone_preview: priceZone.slice(0, 300).replace(/\s+/g, ' '),
        strategy_used:      dbgStrat,
        net_price,
      })
    }

    seen.add(sku)
    items.push({ sku, name: name.slice(0, 200), quantity, net_price })
  }

  // ── Pass 2: manual lines (no SKU label) ───────────────────────────────────
  const MANUAL_SKIP_RE = /^(?:Subtotal|Levering|Fragt|Forsendelse|Shipping|I\s+alt|Total\b|Moms|Skat|Ordrenummer|Betaling|Faktura|FORHANDLER|SLUTKUNDE|Tilbud\b|Draft\b|Betalings|Rabat\b|Du\s+har\s+sparet)/i
  const seenManualNames = new Set()

  for (const pm of html.matchAll(PRICE_RE)) {
    const price = parsePrice(pm[0])
    if (price < 10) continue

    const claimedBy = claimedRanges.filter(([a, b]) => pm.index >= a && pm.index <= b)
    if (claimedBy.length) {
      if (debugCollector) debugCollector.pass2.push({
        price, pos: pm.index, skip: 'in_claimed_range',
        claimed_by: claimedBy.map(([a, b]) => `[${a}–${b}]`).join(', '),
        match: pm[0],
      })
      continue
    }

    const beforeText = stripTags(
      html.slice(Math.max(0, pm.index - 500), pm.index).replace(/^[^<]*>/, '')
    )
    const lines = beforeText.split('\n').map(l => l.trim())

    const tailText = lines.slice(-4).join(' ')
    if (/(?:Subtotal|I\s+alt|Total\b|Moms\b|Skat\b)/i.test(tailText)) {
      if (debugCollector) debugCollector.pass2.push({
        price, pos: pm.index, skip: 'totals_section',
        context: tailText.slice(0, 120),
      })
      continue
    }

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

    // Skip Shopify bundle sub-items (child rows "IA900 Basis-pakke × 1" etc.)
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
      sku: null, name, quantity: 1,
      net_price: price, gross_price: price, type: 'manual',
    })
  }

  return items
}

function parseDelivery(html) {
  const text = stripTags(html)
  const re = /(?:^|\n)\s*(?:Levering|Fragt|Forsendelse|Shipping|Delivery)\s*[:\-]?\s*([\d.,]+\s*(?:DKK|kr\.?)?)/im
  const m  = text.match(re)
  if (!m) return null
  const amount = parsePrice(m[1])
  return amount > 0 ? amount : null
}

function parseDiscounts(html) {
  const text        = stripTags(html)
  const lines       = text.split('\n').map(l => l.trim()).filter(Boolean)
  const discounts   = []
  const seenAmounts = new Set()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

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

    if (/^Rabat\b/i.test(line)) {
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

function parseAddress(html) {
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
    if (!l)              continue
    if (STOP_RE.test(l)) break
    addressLines.push(l)
  }

  const company = addressLines[0] || ''
  return { company, address: addressLines.join(', ') }
}

/**
 * Build the standard { skuItems, manualItems, delivery, discounts, address }
 * shape from raw email HTML. Used when the Admin API is unavailable.
 */
function buildItemsFromEmail(emailHtml, debugCollector = null) {
  const rawItems    = parseLineItems(emailHtml, debugCollector)
  const skuItems    = rawItems.filter(i => i.type !== 'manual')
  const manualItems = rawItems.filter(i => i.type === 'manual')
  const delivery    = parseDelivery(emailHtml)
  const discounts   = parseDiscounts(emailHtml)
  const address     = parseAddress(emailHtml)
  return { skuItems, manualItems, delivery, discounts, address, debugCollector }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── PRIMARY: Shopify Admin API parsing ───────────────────────────────────────
//
// Price semantics (Shopify Admin REST):
//   item.price              – unit price (before any line-level discount)
//   item.applied_discount   – { amount, type, value } — LINE-level discount
//   draftOrder.applied_discount – ORDER-level discount applied after subtotal
//
// For dealer quotes:
//   net_price = item.price − item.applied_discount.amount / qty
//   Order-level discount → pushed as a separate 'discount' line item
//
// For customer quotes:
//   The order-level discount is distributed proportionally across items by
//   price weight so each item's gross_price already reflects the discount.
//   No separate discount line item is emitted for customer quotes.
// ─────────────────────────────────────────────────────────────────────────────

function buildItemsFromDraftOrder(draftOrder, isCustomerQuote = false) {
  const skuItems    = []
  const manualItems = []
  const discounts   = []
  let   delivery    = null

  // ── Log order-level discount so we can see where the discount lives ─────────
  console.log('[order-discount]', draftOrder.applied_discount)

  const od               = draftOrder.applied_discount
  const orderDiscountAmt = parseFloat(od?.amount || 0)

  // Pre-compute total (price × qty) across all line items for proportional split
  let totalBeforeDiscount = 0
  if (isCustomerQuote && orderDiscountAmt > 0) {
    for (const item of (draftOrder.line_items || [])) {
      totalBeforeDiscount +=
        parseFloat(item.price || 0) * Math.max(item.quantity || 1, 1)
    }
    console.log('[order-discount] isCustomerQuote=true, orderDiscountAmt=', orderDiscountAmt,
      'totalBeforeDiscount=', totalBeforeDiscount)
  }

  for (const item of (draftOrder.line_items || [])) {
    const unitPrice    = parseFloat(item.price || 0)
    const lineDiscAmt  = parseFloat(item.applied_discount?.amount || 0)
    const qty          = Math.max(item.quantity || 1, 1)

    // Log both discount locations so we can confirm where the 31 095 lives
    console.log('[customer-price]', item.sku,
      'item.price=', item.price,
      'compare_at=', item.compare_at_price,
      'item.applied_discount=', item.applied_discount,
      'order.applied_discount=', draftOrder.applied_discount)

    // Dealer net_price: item price minus any LINE-level discount
    const net_price = Math.round(unitPrice - lineDiscAmt / qty)

    // Customer gross_price: item price minus its proportional share of the
    // ORDER-level discount.  Falls back to unitPrice when no order discount.
    let shopify_price = Math.round(unitPrice)
    if (isCustomerQuote && orderDiscountAmt > 0 && totalBeforeDiscount > 0) {
      const lineTotal      = unitPrice * qty
      const itemDiscount   = (lineTotal / totalBeforeDiscount) * orderDiscountAmt
      const finalUnitPrice = unitPrice - (itemDiscount / qty)
      shopify_price        = Math.round(finalUnitPrice)
      console.log('[order-discount] SKU', item.sku,
        'lineTotal=', lineTotal,
        'itemDiscount=', Math.round(itemDiscount),
        'finalUnitPrice=', shopify_price)
    }

    const hasSku = item.sku && item.sku.trim() && !item.custom
    if (hasSku) {
      skuItems.push({
        sku:          item.sku.trim().toUpperCase(),
        name:         item.title || item.sku,
        quantity:     qty,
        net_price,
        // shopify_price = post-order-discount unit price for customer quotes;
        // equals item.price (no adjustment) for dealer quotes.
        shopify_price,
      })
    } else {
      manualItems.push({
        sku: null, name: item.title || '(manual)',
        quantity: qty, net_price, gross_price: net_price, type: 'manual',
      })
    }
  }

  const shippingPrice = parseFloat(draftOrder.shipping_line?.price || 0)
  if (shippingPrice > 0) delivery = Math.round(shippingPrice)

  // Order-level discount → separate line for dealer quotes only.
  // For customer quotes it has already been folded into shopify_price above.
  if (!isCustomerQuote && orderDiscountAmt > 0) {
    const amt = Math.round(orderDiscountAmt)
    discounts.push({
      sku: null, name: od.title || 'Rabat', quantity: 1,
      net_price: -amt, gross_price: -amt, type: 'discount',
    })
  }

  const sa         = draftOrder.shipping_address || {}
  const dealerName = sa.company || [sa.first_name, sa.last_name].filter(Boolean).join(' ') || ''
  const addrParts  = [sa.address1, sa.address2,
    [sa.zip, sa.city].filter(Boolean).join(' '), sa.country].filter(Boolean)
  const address = { company: dealerName, address: addrParts.join(', ') }

  return { skuItems, manualItems, delivery, discounts, address, debugCollector: null }
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
    seller_email = '',
  } = req.body

  const debug = req.query.debug === '1'

  // Parse "Name <email>" or bare "email" from the From header value
  const fromMatch  = seller_email.match(/^(.+?)\s*<([^>]+)>/)
  const sellerAddr = fromMatch ? fromMatch[2].trim() : seller_email.trim()

  // Look up full seller record from the CEPELO directory (name, title, phone)
  const sellerRecord = getSellerByEmail(sellerAddr)

  // Determine display name: directory wins, then RFC 5322 display name, then derive from local part
  let sellerName = sellerRecord?.name || (fromMatch ? fromMatch[1].trim() : '')
  if (!sellerName && sellerAddr.includes('@')) {
    sellerName = sellerAddr
      .split('@')[0]
      .replace(/[._+\-]+/g, ' ')
      .split(' ')
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ')
  }

  // ── 1. Parse subject → extract quote_ref, type, recipient ─────────────────
  const subjectData = parseSubject(subject)

  // Fallback: try to extract quote ref from body HTML
  if (!subjectData.quote_ref) {
    const rawHtml = (body_html || html_field || '')
      .replace(/&nbsp;/g, ' ').replace(/&#160;/g, ' ')
    subjectData.quote_ref = parseQuoteRef(rawHtml)
  }

  // Fallback: try to extract recipient company from body HTML
  if (!subjectData.recipient_company) {
    const bodyText = stripTags(body_html || html_field || '').slice(0, 400)
    const dealerM  = bodyText.match(/FORHANDLER\s*\|[^:]*:\s*(.+?)\s*[-–\n]/i)
    const custM    = bodyText.match(/SLUTKUNDE\s*\|[^:]*:\s*(.+?)\s*[-–\n]/i)
    if (dealerM) { subjectData.type = 'dealer';   subjectData.recipient_company = dealerM[1].trim() }
    if (custM)   { subjectData.type = 'customer'; subjectData.recipient_company = custM[1].trim() }
  }

  // ── 2. Get line items – Admin API primary, HTML fallback ──────────────────
  let items  = null
  let source = 'unknown'

  // ── 2a. Try Shopify Admin API ──────────────────────────────────────────────
  if (subjectData.quote_ref) {
    try {
      const draftOrder = await fetchDraftOrderByRef(subjectData.quote_ref)
      if (draftOrder) {
        items  = buildItemsFromDraftOrder(draftOrder, subjectData.type === 'customer')
        source = 'shopify_admin_api'
        console.log(`[parse-email] Loaded ${subjectData.quote_ref} from Shopify Admin API`)
      } else {
        console.warn(`[parse-email] Draft order ${subjectData.quote_ref} not found via Admin API — trying HTML fallback`)
      }
    } catch (e) {
      // Auth / token errors → fall back to HTML.
      // Timeout / 5xx → fail fast (something is badly wrong).
      const isAuthError = /401|not configured|invalid.*token|unauthorized/i.test(e.message)
      if (isAuthError) {
        console.warn('[parse-email] Admin API auth error, falling back to HTML parsing:', e.message)
      } else {
        console.error('[parse-email] Admin API error (non-auth):', e.message)
        return res.status(502).json({ error: `Shopify API error: ${e.message}` })
      }
    }
  }

  // ── 2b. HTML fallback ──────────────────────────────────────────────────────
  if (!items) {
    const rawHtml = body_html || html_field || ''
    if (!rawHtml.trim()) {
      return res.status(422).json({
        error: subjectData.quote_ref
          ? `Draft order ${subjectData.quote_ref} not found and no body_html provided for fallback`
          : 'No quote reference found in subject and no body_html provided',
        hint: 'Either fix SHOPIFY_ADMIN_TOKEN in Vercel env vars, or ensure body_html is included in the request',
      })
    }
    const emailHtml = rawHtml
      .replace(/&nbsp;/g,  ' ')
      .replace(/&#160;/g,  ' ')
      .replace(/(DKK|kr\.?)\s+([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)/gi, '$2 $1')

    const htmlDebugCollector = debug ? { priceStrategies: [], pass2: [] } : null
    items  = buildItemsFromEmail(emailHtml, htmlDebugCollector)
    source = 'html_fallback'
    console.log(`[parse-email] Using HTML fallback for ${subjectData.quote_ref || '(no ref)'}`)
  }

  const { skuItems, manualItems, delivery, discounts, address, debugCollector } = items

  if (skuItems.length === 0) {
    return res.status(422).json({
      error:  'No SKU line items found',
      hint:   source === 'html_fallback'
        ? 'Ensure the email body contains "Varenummer: XXXXX" for each product'
        : 'Ensure the draft order contains at least one catalog product with a SKU/variant',
      source,
      subject: subjectData,
    })
  }

  // ── 3. Shopify Storefront enrichment (images, descriptions, gross_price) ──
  // isCustomerQuote must be known here so fetchProductBySku can skip the
  // vejl_udsalgspris metafield override (which would clobber the discount-
  // adjusted gross_price we already computed in buildItemsFromDraftOrder).
  const isCustomerQuote = subjectData.type === 'customer'

  const enriched = await Promise.all(
    skuItems.map(async item => {
      let shopify = null
      try {
        shopify = await fetchProductBySku(item.sku, isCustomerQuote)
        if (!shopify) console.warn(`[parse-email] SKU ${item.sku} not found in Shopify Storefront`)
      } catch (e) {
        console.warn(`[parse-email] Storefront error for ${item.sku}:`, e.message)
      }
      return { ...item, shopify }
    })
  )

  // ── 4. Build main_product + line_items ───────────────────────────────────
  const [first, ...rest] = enriched

  // For customer quotes the discount is already reflected in item.shopify_price
  // (Shopify stores the final custom/agreed price in item.price directly).
  // Don't show discounts as separate line items in the customer-facing view.
  const discountsForLineItems = isCustomerQuote ? [] : discounts

  function buildProduct(item) {
    const s = item.shopify
    return {
      ...(s && {
        name:               s.name,
        description:        s.description,
        description_html:   s.description_html,
        image_url:          s.image_url,
        images:             s.images,
        video_url:          s.video_url || undefined,
        currency:           s.currency,
        vendor:             s.vendor,
        product_type:       s.product_type,
        shopify_handle:     s.handle,
        shopify_product_id: s.shopify_product_id,
      }),
      sku:         item.sku,
      name:        s?.name || item.name,
      quantity:    item.quantity,
      net_price:   isCustomerQuote ? 0 : item.net_price,
      // Customer quotes: net_price = item.price − item.applied_discount.amount / qty,
      // which already reflects any line-level discount (e.g. 66995 − 31095 = 35900).
      // Order-level discount is handled proportionally via shopify_price when present,
      // but net_price is the authoritative final price for line-discount orders.
      gross_price: isCustomerQuote ? item.net_price : (s?.gross_price || 0),
    }
  }

  const main_product = buildProduct(first)
  console.log('[video] main_product.video_url:', main_product.video_url)
  const line_items   = rest.map(buildProduct)

  manualItems.forEach(item => line_items.push({
    sku:         null,
    name:        item.name,
    quantity:    item.quantity,
    net_price:   isCustomerQuote ? 0              : item.net_price,
    gross_price: isCustomerQuote ? item.net_price : item.gross_price,
    type:        'manual',
  }))

  if (delivery !== null) {
    line_items.push({
      sku: 'DELIVERY', name: 'Levering', quantity: 1,
      net_price: delivery, gross_price: delivery, currency: 'DKK',
    })
  }

  discountsForLineItems.forEach(d => line_items.push(d))

  // ── 5. Accessories — live Shopify recommendations, static fallback ────────
  // Collect SKUs already in the quote so we can exclude them from suggestions
  const quotedSkus = new Set(
    [first.sku, ...rest.map(i => i.sku), ...manualItems.map(i => i.sku)]
      .filter(Boolean)
  )

  let available_accessories = []
  const mainProductGid = first.shopify?.shopify_product_id

  if (mainProductGid) {
    try {
      const recs = await fetchAccessoriesFromMetafields(mainProductGid)
      available_accessories = recs.filter(r => r.sku && !quotedSkus.has(r.sku))
      console.log(`[parse-email] Metafield accessories: ${recs.length} raw → ${available_accessories.length} after dedup. GID=${mainProductGid}`)
    } catch (e) {
      console.warn('[parse-email] fetchAccessoriesFromMetafields failed — accessories will be empty:', e.message)
    }
  } else {
    console.log('[parse-email] No shopify_product_id on main product — accessories will be empty')
  }

  // ── 6. Parsed summary ─────────────────────────────────────────────────────
  const parsedSummary = {
    source,
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
        sku: null, name: i.name, quantity: i.quantity,
        net_price: i.net_price, type: 'manual',
      })),
      ...discounts.map(d => ({
        sku: null, name: d.name, net_price: d.net_price, type: 'discount',
      })),
    ],
    accessories_count: available_accessories.length,
    discount_count:    discounts.length,
  }

  // ── 7. Debug mode – return structured data without writing ────────────────
  if (debug) {
    return res.status(200).json({
      debug:  true,
      source,
      // HTML fallback debug (only present when source === 'html_fallback')
      ...(debugCollector && {
        price_strategies: debugCollector.priceStrategies,
        pass2_hits:       debugCollector.pass2,
        sku_items_raw:    skuItems,
        manual_items_raw: manualItems,
      }),
      parsed:      parsedSummary,
      main_product,
      line_items,
    })
  }

  // ── 8. Insert DRAFT quote into Supabase ──────────────────────────────────
  const token          = randomBytes(16).toString('hex')
  const customer_token = randomBytes(16).toString('hex')
  const draft_token    = randomBytes(16).toString('hex')
  const validUntil     = new Date()
  validUntil.setDate(validUntil.getDate() + valid_days)

  const { error } = await adminClient.from('quotes').insert({
    token,
    customer_token,
    draft_token,
    shopify_order_id:  subjectData.quote_ref || 'PARSED',
    type:              subjectData.type,
    lang,
    category:          'other',
    status:            'draft',
    sender_name:       sellerName || '',
    sender_email:      sellerAddr || process.env.DEFAULT_SENDER_EMAIL || '',
    sender_phone:      sellerRecord?.phone || '',
    recipient_name:    '',
    recipient_company: subjectData.recipient_company || '',
    recipient_email:   '',
    recipient_phone:   '',
    dealer_name:       address.company || '',
    dealer_email:      '',
    main_product,
    line_items,
    available_accessories,
    notes:             address.address ? `Leveringsadresse: ${address.address}` : '',
    valid_until:       validUntil.toISOString().split('T')[0],
  })

  if (error) {
    console.error('[parse-email] Supabase insert error:', error)
    return res.status(500).json({ error: `Supabase error: ${error.message}` })
  }

  const baseUrl       = process.env.NEXT_PUBLIC_BASE_URL
  const sellerFormUrl = `${baseUrl}/seller/${draft_token}`

  // ── 9. Notify the CEPELO seller ──────────────────────────────────────────
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
      console.warn('[parse-email] Seller notification email failed:', emailErr.message)
    }
  }

  return res.status(200).json({
    success:         true,
    source,
    draft_token,
    seller_form_url: sellerFormUrl,
    seller_email:    sellerAddr || null,
    parsed:          parsedSummary,
  })
}

// Named exports used by /api/test-parse
export { parseSubject, parseQuoteRef, stripTags, parsePrice, buildItemsFromDraftOrder, buildItemsFromEmail }
