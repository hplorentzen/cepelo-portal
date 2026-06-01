// pages/api/accept-quote.js
//
// Called when a customer clicks "Acceptér tilbud" on the quote page.
//
// POST /api/accept-quote
// Body (JSON):
//   customer_token       – identifies the quote (from the URL)
//   selected_accessories – array of accessory objects the customer ticked
//
// On success:
//   1. Marks quote as 'accepted' in Supabase
//   2. Emails the dealer asking them to fill in workshop/order details
//   3. Emails the CEPELO seller with acceptance confirmation + pricing

import { createClient } from '@supabase/supabase-js'
import { sendEmail, orderConfirmedDealerEmail, orderConfirmedSellerEmail } from '../../lib/email'
import { getSellerByEmail } from '../../lib/sellers'

const adminClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { customer_token, selected_accessories = [] } = req.body
  if (!customer_token) return res.status(400).json({ error: 'customer_token is required' })

  // ── 1. Fetch quote ──────────────────────────────────────────────────────────
  const { data: quote, error: fetchErr } = await adminClient
    .from('quotes')
    .select('*')
    .eq('customer_token', customer_token)
    .single()

  if (fetchErr || !quote) return res.status(404).json({ error: 'Quote not found' })
  if (quote.status === 'accepted') {
    return res.status(200).json({ success: true, already_accepted: true })
  }

  // ── 2. Mark as accepted ─────────────────────────────────────────────────────
  const { error: updateErr } = await adminClient
    .from('quotes')
    .update({ status: 'accepted', accepted_at: new Date().toISOString() })
    .eq('customer_token', customer_token)

  if (updateErr) {
    console.error('[accept-quote] Supabase update error:', updateErr)
    return res.status(500).json({ error: `Supabase error: ${updateErr.message}` })
  }

  // ── 3. Build product list (main + line items + selected accessories) ─────────
  const mainProduct  = quote.main_product ? [quote.main_product] : []
  const lineItems    = (quote.line_items || []).filter(i => i.sku !== 'DELIVERY')
  const allProducts  = [...mainProduct, ...lineItems, ...(selected_accessories || [])]

  const baseUrl      = process.env.NEXT_PUBLIC_BASE_URL
  const orderFormUrl = `${baseUrl}/order/${quote.token}`

  // ── 4. Email the dealer ─────────────────────────────────────────────────────
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

  // ── 5. Email the CEPELO seller ───────────────────────────────────────────────
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
