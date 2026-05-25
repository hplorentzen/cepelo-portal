// pages/api/create-quote.js
import { createClient } from '@supabase/supabase-js'
import { randomBytes } from 'crypto'

const adminClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const secret = req.headers['x-cepelo-secret']
  if (secret !== process.env.CEPELO_API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { shopify_draft_order_id, valid_days = 30 } = req.body

  if (!shopify_draft_order_id) {
    return res.status(400).json({ error: 'shopify_draft_order_id is required' })
  }

  try {
    const token = randomBytes(16).toString('hex')
    const validUntil = new Date()
    validUntil.setDate(validUntil.getDate() + valid_days)

    const { data: quote, error } = await adminClient.from('quotes').insert({
      token,
      shopify_order_id: shopify_draft_order_id,
      type: req.body.type || 'dealer',
      lang: req.body.lang || 'da',
      category: req.body.category || 'other',
      status: 'sent',
      sender_name: req.body.sender_name || '',
      sender_email: req.body.sender_email || process.env.DEFAULT_SENDER_EMAIL,
      sender_phone: req.body.sender_phone || '',
      recipient_name: req.body.recipient_name || '',
      recipient_company: req.body.recipient_company || '',
      recipient_email: req.body.recipient_email || '',
      recipient_phone: req.body.recipient_phone || '',
      dealer_name: req.body.dealer_name || '',
      dealer_email: req.body.dealer_email || '',
      main_product: req.body.main_product || null,
      line_items: req.body.line_items || [],
      available_accessories: req.body.available_accessories || [],
      notes: req.body.notes || '',
      valid_until: validUntil.toISOString().split('T')[0],
    }).select().single()

    if (error) throw new Error(`Supabase error: ${error.message}`)

    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL
    const quoteUrl = `${baseUrl}/quote/${token}`

    return res.status(200).json({
      success: true,
      token,
      quote_url: quoteUrl,
      customer_url: `${quoteUrl}?view=customer`,
    })
  } catch (err) {
    console.error('create-quote error:', err)
    return res.status(500).json({ error: err.message })
  }
}
