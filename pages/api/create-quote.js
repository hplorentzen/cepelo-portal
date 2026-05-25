// pages/api/create-quote.js
import { createClient } from '@supabase/supabase-js'
import { randomBytes } from 'crypto'
import { getAccessoriesForSku } from '../../lib/accessories'
import { fetchProductBySku } from '../../lib/shopify'

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
    const mainSku = req.body.main_product?.sku || null

    // ── 1. Shopify product enrichment ──────────────────────────────────────
    // Fetch product data from Shopify when a SKU is provided.
    // Caller-supplied fields always take priority over Shopify data.
    let shopifyProduct = null
    if (mainSku) {
      try {
        shopifyProduct = await fetchProductBySku(mainSku)
        if (shopifyProduct) {
          console.log(`[create-quote] Shopify enrichment OK for SKU ${mainSku}: ${shopifyProduct.name}`)
        } else {
          console.warn(`[create-quote] SKU ${mainSku} not found in Shopify`)
        }
      } catch (e) {
        console.warn('[create-quote] Shopify product fetch failed:', e.message)
      }
    }

    // Build main_product: Shopify data as base, caller fields override
    const mainProduct = mainSku
      ? {
          // Shopify defaults (skipped when shopifyProduct is null)
          ...(shopifyProduct && {
            name:               shopifyProduct.name,
            description:        shopifyProduct.description,
            description_html:   shopifyProduct.description_html,
            image_url:          shopifyProduct.image_url,
            images:             shopifyProduct.images,
            gross_price:        shopifyProduct.gross_price,
            net_price:          shopifyProduct.net_price,
            currency:           shopifyProduct.currency,
            vendor:             shopifyProduct.vendor,
            product_type:       shopifyProduct.product_type,
            shopify_handle:     shopifyProduct.handle,
            shopify_product_id: shopifyProduct.shopify_product_id,
          }),
          // Caller-supplied fields override everything above
          ...req.body.main_product,
        }
      : (req.body.main_product || null)

    // ── 2. Available accessories ───────────────────────────────────────────
    // If the caller explicitly supplies available_accessories, use those as-is.
    // Otherwise build the list from two sources:
    //   a) Static accessories from lib/accessories.js (curated, SKU-specific + global)
    //   b) Shopify product recommendations (deduplicated against static list)
    let availableAccessories = req.body.available_accessories ?? null

    if (availableAccessories === null) {
      // a) Static / curated accessories
      const staticAccessories = mainSku ? getAccessoriesForSku(mainSku) : []

      // Only use curated static accessories — Shopify recommendations are too unpredictable
      availableAccessories = staticAccessories
    }

    // ── 3. Insert quote into Supabase ──────────────────────────────────────
    const token = randomBytes(16).toString('hex')
    const validUntil = new Date()
    validUntil.setDate(validUntil.getDate() + valid_days)

    const { data: quote, error } = await adminClient.from('quotes').insert({
      token,
      shopify_order_id:      shopify_draft_order_id,
      type:                  req.body.type     || 'dealer',
      lang:                  req.body.lang     || 'da',
      category:              req.body.category || 'other',
      status:                'sent',
      sender_name:           req.body.sender_name    || '',
      sender_email:          req.body.sender_email   || process.env.DEFAULT_SENDER_EMAIL,
      sender_phone:          req.body.sender_phone   || '',
      recipient_name:        req.body.recipient_name    || '',
      recipient_company:     req.body.recipient_company || '',
      recipient_email:       req.body.recipient_email   || '',
      recipient_phone:       req.body.recipient_phone   || '',
      dealer_name:           req.body.dealer_name  || '',
      dealer_email:          req.body.dealer_email || '',
      main_product:          mainProduct,
      line_items:            req.body.line_items || [],
      available_accessories: availableAccessories,
      notes:                 req.body.notes || '',
      valid_until:           validUntil.toISOString().split('T')[0],
    }).select().single()

    if (error) throw new Error(`Supabase error: ${error.message}`)

    const baseUrl  = process.env.NEXT_PUBLIC_BASE_URL
    const quoteUrl = `${baseUrl}/quote/${token}`

    return res.status(200).json({
      success:               true,
      token,
      quote_url:             quoteUrl,
      customer_url:          `${quoteUrl}?view=customer`,
      shopify_enriched:      !!shopifyProduct,
      recommendations_count: availableAccessories.filter(a => a.type === 'product').length,
    })
  } catch (err) {
    console.error('[create-quote] error:', err)
    return res.status(500).json({ error: err.message })
  }
}
