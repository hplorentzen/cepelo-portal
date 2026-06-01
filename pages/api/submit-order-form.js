// pages/api/submit-order-form.js
//
// Called when the dealer submits their workshop/order details form.
//
// POST /api/submit-order-form
// Body (JSON):
//   dealer_token    – the dealer's quote token (from the URL)
//   company_name    – workshop name
//   address         – delivery address
//   cvr             – CVR number
//   contact_name    – contact person name
//   contact_email   – contact person email
//   contact_phone   – contact person phone
//   po_number       – optional PO / ordre reference

import { createClient } from '@supabase/supabase-js'
import { sendEmail, workshopDetailsSellerEmail } from '../../lib/email'
import { getSellerByEmail } from '../../lib/sellers'

const adminClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const {
    dealer_token,
    company_name  = '',
    address       = '',
    cvr           = '',
    contact_name  = '',
    contact_email = '',
    contact_phone = '',
    po_number     = '',
  } = req.body

  if (!dealer_token)  return res.status(400).json({ error: 'dealer_token is required' })
  if (!company_name)  return res.status(400).json({ error: 'company_name is required' })

  // ── 1. Fetch quote ──────────────────────────────────────────────────────────
  const { data: quote, error: fetchErr } = await adminClient
    .from('quotes')
    .select('*')
    .eq('token', dealer_token)
    .single()

  if (fetchErr || !quote) return res.status(404).json({ error: 'Quote not found' })

  // ── 2. Update status to order_submitted ────────────────────────────────────
  const workshop = { company_name, address, cvr, contact_name, contact_email, contact_phone, po_number }

  const { error: updateErr } = await adminClient
    .from('quotes')
    .update({ status: 'order_submitted' })
    .eq('token', dealer_token)

  if (updateErr) {
    console.warn('[submit-order-form] Supabase status update failed (non-fatal):', updateErr.message)
    // Non-fatal — we still send the email
  }

  // ── 3. Build product list ───────────────────────────────────────────────────
  const mainProduct = quote.main_product ? [quote.main_product] : []
  const lineItems   = (quote.line_items || []).filter(i => i.sku !== 'DELIVERY')
  const allProducts = [...mainProduct, ...lineItems]

  // ── 4. Email the CEPELO seller ───────────────────────────────────────────────
  const sellerRecord = getSellerByEmail(quote.sender_email || '')
  const sellerEmail  = sellerRecord?.email || quote.sender_email

  if (!sellerEmail) {
    console.warn('[submit-order-form] No seller email found for quote', quote.shopify_order_id)
    return res.status(200).json({ success: true, email_sent: false })
  }

  try {
    const tpl = workshopDetailsSellerEmail({
      quoteRef:   quote.shopify_order_id,
      dealerName: quote.dealer_name || '',
      workshop,
      products:   allProducts,
    })
    await sendEmail({
      to:      sellerEmail,
      ...tpl,
      replyTo: contact_email || quote.dealer_email || undefined,
    })
    console.log(`[submit-order-form] Seller email sent to ${sellerEmail} for ${quote.shopify_order_id}`)
  } catch (e) {
    console.error('[submit-order-form] Seller email failed:', e.message)
    return res.status(500).json({ error: 'Email delivery failed', detail: e.message })
  }

  return res.status(200).json({ success: true, email_sent: true })
}
