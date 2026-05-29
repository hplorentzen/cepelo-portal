// pages/api/test-parse.js
//
// Development/debugging endpoint: fetch a Shopify draft order by reference and
// run it through the buildItemsFromDraftOrder parser — no Supabase writes.
//
// POST /api/test-parse
// Headers: x-cepelo-secret: <CEPELO_API_SECRET>
// Body (JSON):
//   order_ref – Shopify draft order reference, e.g. "#D4760" or "D4760" (required)
//   subject   – email subject line (optional; used for type/dealer detection)
//
// Returns full debug output:
//   shopify_draft_order  – raw Shopify API response (line_items, discounts, address…)
//   sku_items            – catalog products parsed from the draft order
//   manual_items         – custom/service line items
//   delivery             – shipping cost (or null)
//   discounts            – order-level discounts
//   address              – parsed shipping address
//   subject              – parsed subject metadata
//
// Usage:
//   curl -s -X POST https://cepelo-portal.vercel.app/api/test-parse \
//     -H "Content-Type: application/json" \
//     -H "x-cepelo-secret: $CEPELO_API_SECRET" \
//     -d '{"order_ref":"#D4760","subject":"FORHANDLER | Slutkunde: X - Tilbud #D4760"}' \
//     | jq .

import { fetchDraftOrderByRef } from '../../lib/shopify'
import { parseSubject, buildItemsFromDraftOrder } from './parse-email'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const secret = req.headers['x-cepelo-secret']
  if (secret !== process.env.CEPELO_API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { order_ref, subject = '' } = req.body
  if (!order_ref?.trim()) return res.status(400).json({ error: 'order_ref is required' })

  const subjectData = parseSubject(subject)

  let draftOrder = null
  try {
    draftOrder = await fetchDraftOrderByRef(order_ref.trim())
  } catch (e) {
    return res.status(502).json({ error: `Shopify API error: ${e.message}` })
  }

  if (!draftOrder) {
    return res.status(404).json({
      error: `Draft order "${order_ref.trim()}" not found in Shopify`,
      hint:  'Checked statuses: open, invoice_sent, completed',
    })
  }

  const { skuItems, manualItems, delivery, discounts, address } =
    buildItemsFromDraftOrder(draftOrder)

  return res.status(200).json({
    subject:             subjectData,
    // Parsed results ──────────────────────────────────────────────────────────
    sku_items:           skuItems,
    manual_items:        manualItems,
    delivery,
    discounts,
    address,
    // Raw Shopify draft order ─────────────────────────────────────────────────
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
  })
}
