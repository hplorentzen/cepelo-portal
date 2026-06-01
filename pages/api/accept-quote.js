// pages/api/accept-quote.js
//
// Called when a customer clicks "Acceptér tilbud" on the quote page.
//
// POST /api/accept-quote
// Body (JSON):
//   customer_token       – identifies the quote (from the URL)
//   selected_accessories – array of accessory objects the customer ticked
//   main_gross           – dealer-edited main product gross price (number, excl. VAT)
//   line_gross           – array of dealer-edited line item totals (price × qty, excl. VAT)
//
// On success:
//   1. Saves final dealer-edited prices back to Supabase
//   2. Marks quote as 'accepted'
//   3. Emails the dealer asking them to fill in workshop/order details
//   4. Emails the CEPELO seller with acceptance confirmation + final pricing

import { createClient } from '@supabase/supabase-js'
import { sendEmail, orderConfirmedDealerEmail, orderConfirmedSellerEmail } from '../../lib/email'
import { getSellerByEmail } from '../../lib/sellers'

const adminClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const {
    customer_token,
    selected_accessories = [],
    main_gross,
    line_gross = [],
  } = req.body

  if (!customer_token) return res.status(400).json({ error: 'customer_token is required' })

  // ── 1. Fetch quote ──────────────────────────────────────────────────────────
  const { data: quote, error: fetchErr } = await adminClient
    .from('quotes')
    .select('*')
    .eq('customer_token', customer_token)
    .single()

  if (fetchErr || !quote) return res.status(404).json({ error: 'Quote not found' })
  if (quote.status === 'accepted' || quote.status === 'order_submitted') {
    return res.status(200).json({ success: true, already_accepted: true })
  }

  // ── 2. Apply dealer-edited prices to main_product and line_items ────────────
  // line_gross values are totals (price × qty); store per-unit gross_price in DB
  const updatedMainProduct = quote.main_product
    ? {
        ...quote.main_product,
        gross_price: (main_gross != null && main_gross > 0)
          ? Math.round(main_gross)
          : quote.main_product.gross_price,
      }
    : null

  const updatedLineItems = (quote.line_items || []).map((item, idx) => {
    const editedTotal = line_gross[idx]
    if (editedTotal == null || editedTotal <= 0) return item
    // Store per-unit price (total ÷ quantity)
    const perUnit = Math.round(editedTotal / (item.quantity || 1))
    return { ...item, gross_price: perUnit }
  })

  // ── 3. Save to Supabase ─────────────────────────────────────────────────────
  const updatePayload = {
    status:       'accepted',
    accepted_at:  new Date().toISOString(),
    line_items:   updatedLineItems,
    ...(updatedMainProduct ? { main_product: updatedMainProduct } : {}),
  }

  const { error: updateErr } = await adminClient
    .from('quotes')
    .update(updatePayload)
    .eq('customer_token', customer_token)

  if (updateErr) {
    console.error('[accept-quote] Supabase update error:', updateErr)
    return res.status(500).json({ error: `Supabase error: ${updateErr.message}` })
  }

  // ── 4. Build final product list for emails ──────────────────────────────────
  // Include ALL items: main product, all line items, selected accessories
  const allProducts = [
    ...(updatedMainProduct ? [updatedMainProduct] : []),
    ...updatedLineItems,
    ...(selected_accessories || []),
  ]

  const baseUrl      = process.env.NEXT_PUBLIC_BASE_URL
  const orderFormUrl = `${baseUrl}/order/${quote.token}`

  // ── 5. Email the dealer ─────────────────────────────────────────────────────
  if (quote.dealer_email) {
    try {
      const tpl = orderConfirmedDealerEmail({
        dealerName:   quote.dealer_name  || '',
        dealerEmail:  quote.dealer_email,
        quoteRef:     quote.shopify_order_id,
        products:     allProducts,
        orderFormUrl,
      })
      await sendEmail({ to: quote.dealer_email, ...tpl })
      console.log(`[accept-quote] Dealer email sent to ${quote.dealer_email}`)
    } catch (e) {
      console.error('[accept-quote] Dealer email failed:', e.message)
    }
  }

  // ── 6. Email the CEPELO seller ───────────────────────────────────────────────
  const sellerRecord = getSellerByEmail(quote.sender_email || '')
  const sellerEmail  = sellerRecord?.email || quote.sender_email

  if (sellerEmail) {
    try {
      const tpl = orderConfirmedSellerEmail({
        quoteRef:        quote.shopify_order_id,
        customerName:    quote.recipient_name    || '',
        customerCompany: quote.recipient_company || '',
        dealerName:      quote.dealer_name       || '',
        products:        allProducts,
        orderFormUrl,
      })
      await sendEmail({ to: sellerEmail, ...tpl })
      console.log(`[accept-quote] Seller email sent to ${sellerEmail}`)
    } catch (e) {
      console.error('[accept-quote] Seller email failed:', e.message)
    }
  }

  return res.status(200).json({ success: true, order_form_url: orderFormUrl })
}
