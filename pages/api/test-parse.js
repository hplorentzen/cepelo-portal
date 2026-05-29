// pages/api/test-parse.js
//
// Development/debugging endpoint — no Supabase writes.
//
// Accepts either an order_ref (Shopify Admin API path) or raw HTML (fallback
// HTML parsing path), mirrors the same two-path logic as parse-email.js.
//
// POST /api/test-parse
// Headers: x-cepelo-secret: <CEPELO_API_SECRET>
// Body (JSON) — one of:
//   { order_ref: "#D4760", subject: "..." }       ← Admin API path
//   { html: "<raw email html>", subject: "..." }  ← HTML fallback path
//
// Returns:
//   source            – "shopify_admin_api" | "html_fallback"
//   shopify_draft_order – raw Shopify data (Admin API path only)
//   sku_items, manual_items, delivery, discounts, address
//   price_strategies, pass2_hits  (HTML path only, for price debugging)
//
// curl example:
//   curl -s -X POST https://cepelo-portal.vercel.app/api/test-parse \
//     -H "Content-Type: application/json" \
//     -H "x-cepelo-secret: $CEPELO_API_SECRET" \
//     -d '{"order_ref":"#D4760"}' | jq .

import { fetchDraftOrderByRef } from '../../lib/shopify'
import {
  parseSubject,
  buildItemsFromDraftOrder,
  buildItemsFromEmail,
} from './parse-email'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const secret = req.headers['x-cepelo-secret']
  if (secret !== process.env.CEPELO_API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { order_ref, html, subject = '' } = req.body

  if (!order_ref?.trim() && !html?.trim()) {
    return res.status(400).json({ error: 'Provide either order_ref or html' })
  }

  const subjectData = parseSubject(subject)

  // ── Admin API path ─────────────────────────────────────────────────────────
  if (order_ref?.trim()) {
    let draftOrder = null
    try {
      draftOrder = await fetchDraftOrderByRef(order_ref.trim())
    } catch (e) {
      return res.status(502).json({ error: `Shopify API error: ${e.message}` })
    }

    if (!draftOrder) {
      return res.status(404).json({
        error: `Draft order "${order_ref.trim()}" not found`,
        hint:  'Checked statuses: open, invoice_sent, completed',
      })
    }

    const { skuItems, manualItems, delivery, discounts, address } =
      buildItemsFromDraftOrder(draftOrder)

    return res.status(200).json({
      source:       'shopify_admin_api',
      subject:      subjectData,
      sku_items:    skuItems,
      manual_items: manualItems,
      delivery,
      discounts,
      address,
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

  // ── HTML fallback path ────────────────────────────────────────────────────
  const emailHtml = html
    .replace(/&nbsp;/g,  ' ')
    .replace(/&#160;/g,  ' ')
    .replace(/(DKK|kr\.?)\s+([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)/gi, '$2 $1')

  const debugCollector = { priceStrategies: [], pass2: [] }
  const { skuItems, manualItems, delivery, discounts, address } =
    buildItemsFromEmail(emailHtml, debugCollector)

  return res.status(200).json({
    source:           'html_fallback',
    subject:          subjectData,
    sku_items:        skuItems,
    manual_items:     manualItems,
    delivery,
    discounts,
    address,
    price_strategies: debugCollector.priceStrategies,
    pass2_hits:       debugCollector.pass2,
    email_preview:    emailHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 2000),
  })
}
