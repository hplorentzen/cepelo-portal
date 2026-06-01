// pages/api/submit-seller-form.js
//
// Receives the completed seller form, updates the draft quote to 'sent', and
// emails the dealer their quote link.
//
// POST /api/submit-seller-form
// Body (JSON):
//   draft_token        – identifies the draft quote
//   dealer_name        – company name (may be updated by seller)
//   dealer_address     – full delivery address
//   dealer_dept        – department / attention line
//   dealer_email       – where to send the dealer's quote link (required)
//   recipient_company  – end-customer company name
//   recipient_name     – end-customer contact person
//   recipient_email    – end-customer email
//   recipient_phone    – end-customer phone
//   recipient_address  – end-customer delivery address
//   type               – "dealer" | "customer"
//   agreed_price       – optional: updates main_product.gross_price
//   notes              – optional seller note to the dealer

import { createClient } from '@supabase/supabase-js'
import { sendEmail, dealerQuoteEmail } from '../../lib/email'
import { parsePrice } from '../../lib/format'
import { getSellerByEmail } from '../../lib/sellers'

const adminClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const {
    draft_token,
    dealer_name,
    dealer_address,
    dealer_dept,
    dealer_email,
    recipient_company,
    recipient_name,
    recipient_email,
    recipient_phone,
    recipient_address,
    type          = 'dealer',
    agreed_price  = '',
    notes         = '',
  } = req.body

  if (!draft_token)  return res.status(400).json({ error: 'draft_token is required' })
  if (!dealer_email) return res.status(400).json({ error: 'dealer_email is required' })

  // ── Diagnostics ──────────────────────────────────────────────────────────
  console.log('[submit] type=', type)
  console.log('[submit] draft_token=', draft_token)

  // ── 1. Fetch the draft quote ───────────────────────────────────────────────
  const { data: quote, error: fetchErr } = await adminClient
    .from('quotes')
    .select('*')
    .eq('draft_token', draft_token)
    .single()

  if (fetchErr || !quote) {
    console.log('[submit] quote NOT FOUND for draft_token=', draft_token, 'fetchErr=', fetchErr?.message)
    return res.status(404).json({ error: 'Draft quote not found' })
  }

  console.log('[submit] quote found: id=', quote.id, 'status=', quote.status,
    'main_product.gross_price=', quote.main_product?.gross_price,
    'main_product.net_price=',   quote.main_product?.net_price)

  if (quote.status !== 'draft') {
    console.log('[submit] BLOCKED — quote status is', quote.status, '(not draft), update skipped')
    return res.status(409).json({ error: 'Quote has already been submitted', status: quote.status })
  }

  // ── 2. Apply pricing based on quote type ──────────────────────────────────
  //
  // parse-email always stores dealer pricing (gross_price = vejl metafield
  // retail price, net_price = draft-order discounted price).
  //
  // When the seller sets type=customer here, we recalculate:
  //   gross_price = net_price   (the agreed draft-order price the customer pays)
  //   net_price   = 0           (not shown to end customers)
  //
  // Discount and delivery line items are left untouched.
  let mainProduct = quote.main_product ? { ...quote.main_product } : {}
  let lineItems   = [...(quote.line_items || [])]

  if (type === 'customer') {
    // gross_price = net_price when net_price > 0 (the draft-order discounted price).
    // Falls back to keeping gross_price unchanged when net_price is 0 or missing
    // (e.g. quotes originally stored with the old customer-zeroing code).
    const toCustomerPrice = item => {
      if (!item) return item
      if (item.type === 'discount' || item.sku === 'DELIVERY') return item
      const discountedPrice = item.net_price > 0 ? item.net_price : item.gross_price
      return { ...item, gross_price: discountedPrice, net_price: 0 }
    }
    mainProduct = toCustomerPrice(mainProduct)
    lineItems   = lineItems.map(toCustomerPrice)
    console.log('[submit] customer pricing applied — main gross_price will be', mainProduct.gross_price)
  }

  // Optional agreed-price override (applied on top of type-based recalculation)
  const agreedNum = agreed_price ? parsePrice(String(agreed_price)) : 0
  if (agreedNum > 0) {
    mainProduct = { ...mainProduct, gross_price: agreedNum }
  }

  console.log('[submit] mainProduct AFTER pricing: gross_price=', mainProduct.gross_price,
    'net_price=', mainProduct.net_price)

  // ── 3. Build dealer notes (seller message + address context) ─────────────
  const s = (v) => (v || '').trim()
  const noteParts = []
  if (s(notes))             noteParts.push(s(notes))
  if (s(dealer_dept))       noteParts.push(`Afdeling: ${s(dealer_dept)}`)
  if (s(dealer_address))    noteParts.push(`Leveringsadresse: ${s(dealer_address)}`)
  if (s(recipient_address)) noteParts.push(`Slutkunde adresse: ${s(recipient_address)}`)
  const fullNotes = noteParts.join('\n')

  // ── 4. Update quote in Supabase ────────────────────────────────────────────
  const { error: updateErr } = await adminClient
    .from('quotes')
    .update({
      status:            'sent',
      type,
      dealer_name:       dealer_name       || quote.dealer_name  || '',
      dealer_email:      dealer_email,
      dealer_phone:      dealer_dept ? `Afd: ${dealer_dept}` : (quote.dealer_phone || ''),
      recipient_company: recipient_company || quote.recipient_company || '',
      recipient_name:    recipient_name    || '',
      recipient_email:   recipient_email   || '',
      recipient_phone:   recipient_phone   || '',
      main_product:      mainProduct,
      line_items:        lineItems,
      notes:             fullNotes,
    })
    .eq('draft_token', draft_token)

  if (updateErr) {
    console.error('[submit] Supabase update ERROR:', updateErr.message, updateErr)
    return res.status(500).json({ error: `Supabase error: ${updateErr.message}` })
  }
  console.log('[submit] Supabase update SUCCESS — type=', type,
    'main_product.gross_price written=', mainProduct.gross_price)

  const baseUrl    = process.env.NEXT_PUBLIC_BASE_URL
  const quoteUrl   = `${baseUrl}/quote/${quote.token}`
  const customerUrl = `${baseUrl}/quote/${quote.customer_token}`

  // ── 5. Email the dealer ────────────────────────────────────────────────────
  const allProducts = [
    mainProduct,
    ...lineItems.filter(i => i.sku !== 'DELIVERY'),
  ].filter(Boolean)

  const emailUrl = type === 'customer' ? customerUrl : quoteUrl

  try {
    // ── Seller directory lookup diagnostics ─────────────────────────────────
    const rawSenderEmail = quote.sender_email || ''
    const trimmedEmail   = rawSenderEmail.trim().toLowerCase()
    const sellerRecord   = getSellerByEmail(rawSenderEmail)

    console.log('[submit-seller-form] --- SELLER LOOKUP DIAGNOSTICS ---')
    console.log(`[submit-seller-form] quote.sender_email raw   : "${rawSenderEmail}" (length=${rawSenderEmail.length})`)
    console.log(`[submit-seller-form] normalised for lookup     : "${trimmedEmail}"`)
    console.log(`[submit-seller-form] quote.sender_name raw     : "${quote.sender_name}"`)
    console.log(`[submit-seller-form] quote.sender_phone raw    : "${quote.sender_phone}"`)
    console.log(`[submit-seller-form] directory_hit             : ${!!sellerRecord}`)
    if (sellerRecord) {
      console.log(`[submit-seller-form] directory match           : ${sellerRecord.name} / ${sellerRecord.title}`)
    } else {
      console.log('[submit-seller-form] ⚠ email not in sellers.js — known addresses: bc, htm, ahs, lba, tt, tah, at, mr @cepelo.dk')
    }

    const tpl = dealerQuoteEmail({
      dealerName:   dealer_name || quote.dealer_name || '',
      dealerEmail:  dealer_email,
      quoteRef:     quote.shopify_order_id,
      products:     allProducts,
      quoteUrl:     emailUrl,
      senderName:   sellerRecord?.name  || quote.sender_name  || undefined,
      senderTitle:  sellerRecord?.title || undefined,
      senderEmail:  sellerRecord?.email || quote.sender_email || undefined,
      senderPhone:  sellerRecord?.phone || quote.sender_phone || undefined,
      senderPhoto:  sellerRecord?.photo || undefined,
      notes:        s(notes) || undefined,
    })
    await sendEmail({
      to:      dealer_email,
      ...tpl,
      replyTo: sellerRecord?.email || quote.sender_email || undefined,
    })
    console.log(`[submit-seller-form] Dealer email sent to ${dealer_email} for quote ${quote.shopify_order_id}`)
  } catch (emailErr) {
    // Non-fatal — quote is updated in DB even if email fails; log full error for Vercel logs
    console.error('[submit-seller-form] Dealer email failed:', emailErr.message)
    console.error('[submit-seller-form] Email error detail:', emailErr)
  }

  return res.status(200).json({
    success:       true,
    quote_url:     quoteUrl,
    customer_url:  customerUrl,
    dealer_url:    quoteUrl,
    email_sent_to: dealer_email,
  })
}
