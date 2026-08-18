// pages/api/save-dealer-prices.js
//
// Persists dealer-edited gross prices back to Supabase.
// Called from the quote portal when the dealer changes any price field.
//
// POST /api/save-dealer-prices
// Body: {
//   token      – dealer token (auth)
//   main_gross – total gross for main product (may include qty factor)
//   line_gross – array of total gross per line_item index
// }
//
// Prices in state are TOTALS (gross_price × quantity); the DB stores UNIT prices.
// This handler fetches the current quote to get quantities, then stores unit prices.

import { createClient } from '@supabase/supabase-js'

const adminClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { token, main_gross, line_gross } = req.body

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'token required' })
  }

  // Fetch current quote by DEALER token only — customers cannot use this endpoint
  const { data: quote, error: fetchErr } = await adminClient
    .from('quotes')
    .select('main_product, line_items')
    .eq('token', token)
    .single()

  if (fetchErr || !quote) {
    return res.status(404).json({ error: 'Quote not found' })
  }

  // Update main_product gross_price
  // main_gross is a TOTAL (gross_price × quantity); convert to unit price
  const mainQty = Math.max(quote.main_product?.quantity || 1, 1)
  const updatedMain = {
    ...quote.main_product,
    ...(typeof main_gross === 'number' && !isNaN(main_gross) && main_gross >= 0 && {
      gross_price: Math.round(main_gross / mainQty),
    }),
  }

  // Update line_items gross_price per index
  // Skip discounts and DELIVERY — they are non-editable and may have negative/fixed prices
  const updatedLineItems = (quote.line_items || []).map((item, i) => {
    if (item.type === 'discount' || item.sku === 'DELIVERY') return item

    const rawTotal = Array.isArray(line_gross) ? line_gross[i] : undefined
    if (typeof rawTotal !== 'number' || isNaN(rawTotal) || rawTotal < 0) return item

    const qty = Math.max(item.quantity || 1, 1)
    return { ...item, gross_price: Math.round(rawTotal / qty) }
  })

  const { error: updateErr } = await adminClient
    .from('quotes')
    .update({ main_product: updatedMain, line_items: updatedLineItems })
    .eq('token', token)

  if (updateErr) {
    console.error('[save-dealer-prices] Supabase update error:', updateErr)
    return res.status(500).json({ error: updateErr.message })
  }

  return res.status(200).json({ success: true })
}
