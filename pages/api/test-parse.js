// pages/api/test-parse.js
//
// Development/debugging endpoint: run the parse-email parser against HTML you
// paste directly in the request body — no Power Automate, no Supabase writes.
//
// POST /api/test-parse
// Headers: x-cepelo-secret: <CEPELO_API_SECRET>
// Body (JSON):
//   html    – raw email HTML to parse (required)
//   subject – email subject line (optional; used for type/dealer detection)
//
// Returns full debug output (same shape as parse-email ?debug=1):
//   sku_items, manual_items, discounts, delivery, address,
//   price_strategies, pass2_hits, sku_regex_hits, email_preview
//
// Usage: paste the Shopify notification email body into a REST client (e.g.
// Insomnia / Postman / curl) and inspect the response to diagnose price or
// manual-item detection issues without triggering Power Automate.
//
// Example curl:
//   curl -s -X POST https://cepelo-portal.vercel.app/api/test-parse \
//     -H "Content-Type: application/json" \
//     -H "x-cepelo-secret: $CEPELO_API_SECRET" \
//     -d '{"html":"<paste html here>","subject":"FORHANDLER | Slutkunde: ..."}' \
//     | jq .

import {
  parseLineItems,
  parseDelivery,
  parseAddress,
  parseSubject,
  parseDiscounts,
  stripTags,
} from './parse-email'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const secret = req.headers['x-cepelo-secret']
  if (secret !== process.env.CEPELO_API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { html = '', subject = '' } = req.body
  if (!html.trim()) return res.status(400).json({ error: 'html is required' })

  // Same normalisation as the main parse-email handler
  const emailHtml = html
    .replace(/&nbsp;/g,  ' ')
    .replace(/&#160;/g,  ' ')
    .replace(
      /(DKK|kr\.?)\s+([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)/gi,
      '$2 $1'
    )

  const subjectData    = parseSubject(subject)
  const debugCollector = { priceStrategies: [], pass2: [] }
  const rawItems       = parseLineItems(emailHtml, debugCollector)
  const rawSkuItems    = rawItems.filter(i => i.type !== 'manual')
  const rawManualItems = rawItems.filter(i => i.type === 'manual')
  const delivery       = parseDelivery(emailHtml)
  const address        = parseAddress(emailHtml)
  const discounts      = parseDiscounts(emailHtml)

  // Every SKU regex match (pre-dedup) – helps spot missing or double-matched SKUs
  const skuRegexHits = [...emailHtml.matchAll(
    /\b(?:SKU|Varenr\.?|Varenummer)\s*:?\s*([A-Z0-9][A-Z0-9\-_]{2,35})\b/gi
  )].map(m => ({
    sku:       m[1].toUpperCase(),
    fullMatch: m[0],
    index:     m.index,
    context:   emailHtml.slice(Math.max(0, m.index - 60), m.index + 80).replace(/\s+/g, ' '),
  }))

  return res.status(200).json({
    subject:          subjectData,
    // Parsed results ──────────────────────────────────────────────────────────
    sku_items:        rawSkuItems.map(i => ({
      sku:       i.sku,
      name:      i.name,
      quantity:  i.quantity,
      net_price: i.net_price,
    })),
    manual_items:     rawManualItems,
    discounts,
    delivery,
    address,
    // Price-extraction debug (per SKU) ───────────────────────────────────────
    // strategy1_matched  – true if Shopify's order-listitem-price class was found
    // strategy1_content  – text content of that element
    // strategy2_prices   – all valid non-discount prices found in priceZone text
    // has_discount_label – TILPASSET RABAT / KAMPAGNE detected in priceZone
    // strategy_used      – "strategy1_class" | "strategy2_last_discount" | "strategy2_first"
    // net_price          – final parsed price
    price_strategies: debugCollector.priceStrategies,
    // Pass 2 debug (manual item detection) ───────────────────────────────────
    // Each entry: { price, pos, skip, [name], [included], [claimed_by] }
    // skip values: "in_claimed_range" | "totals_section" | "no_name_candidate"
    //              | "bundle_sub_item" | "duplicate_name" | null (= included)
    pass2_hits:       debugCollector.pass2,
    // SKU regex hits ──────────────────────────────────────────────────────────
    sku_regex_hits:   skuRegexHits,
    // Plain-text preview of the normalised HTML (first 2000 chars) ───────────
    email_preview:    stripTags(emailHtml).slice(0, 2000),
  })
}
