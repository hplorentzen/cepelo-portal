// pages/api/create-quote.js
import { createClient } from '@supabase/supabase-js'
import { randomBytes } from 'crypto'
import { getAccessoriesForSku } from '../../lib/accessories'

const adminClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const PLYTIX_AUTH_URL = 'https://auth.plytix.com/auth/api/get-token'
const PLYTIX_BASE     = 'https://pim.plytix.com/api/v1'

async function getPlytixToken() {
  const res = await fetch(PLYTIX_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.PLYTIX_API_KEY,
      api_password: process.env.PLYTIX_API_PASSWORD,
    }),
  })
  if (!res.ok) throw new Error(`Plytix auth failed: ${res.status}`)
  const data = await res.json()
  const token = data?.data?.[0]?.access_token
  if (!token) throw new Error('Plytix auth returned no token')
  return token
}

async function fetchProductBySku(token, sku) {
  // Search by SKU — filters is an array of OR-groups, each group is an array of AND-conditions
  const searchRes = await fetch(`${PLYTIX_BASE}/products/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      filters: [[{ field: 'sku', operator: 'eq', value: sku }]],
      pagination: { page: 1, page_size: 1 },
    }),
  })
  if (!searchRes.ok) throw new Error(`Plytix product search failed: ${searchRes.status}`)
  const searchData = await searchRes.json()
  const hit = searchData?.data?.[0]
  if (!hit?.id) return null

  // Fetch full product attributes
  const detailRes = await fetch(`${PLYTIX_BASE}/products/${hit.id}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  })
  if (!detailRes.ok) throw new Error(`Plytix product detail failed: ${detailRes.status}`)
  const detailData = await detailRes.json()
  return detailData?.data ?? null
}

function extractPlytixProduct(product, requestProduct) {
  if (!product) return requestProduct || null

  const attrs = product.attributes || {}

  // Price: prefer gross_price, fall back to net_price * 1.35
  const netPrice  = Math.round(parseFloat(attrs.net_price  ?? attrs.price_net  ?? attrs.cost ?? 0) || 0)
  const rawGross  = parseFloat(attrs.gross_price ?? attrs.price ?? attrs.price_gross ?? 0) || 0
  const grossPrice = rawGross > 0 ? Math.round(rawGross) : Math.round(netPrice * 1.35)

  // Image: attribute first, then first asset, then thumbnail
  const imageUrl =
    attrs.image_url ||
    product.assets?.[0]?.url ||
    product.thumbnail ||
    null

  return {
    sku: product.sku ?? requestProduct?.sku,
    name:        requestProduct?.name        || attrs.name || attrs.product_name || product.label || product.sku,
    description: requestProduct?.description || attrs.description || attrs.short_description || '',
    image_url:   requestProduct?.image_url   || imageUrl,
    net_price:   requestProduct?.net_price   ?? netPrice,
    gross_price: requestProduct?.gross_price ?? grossPrice,
  }
}

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
    let mainProduct = req.body.main_product || null
    let availableAccessories = req.body.available_accessories ?? null
    let enrichedFromPlytix = false

    const mainSku = mainProduct?.sku

    // ── Plytix enrichment ──────────────────────────────────────────────
    if (mainSku && process.env.PLYTIX_API_KEY && process.env.PLYTIX_API_PASSWORD) {
      try {
        const plytixToken = await getPlytixToken()
        const plytixProduct = await fetchProductBySku(plytixToken, mainSku)
        mainProduct = extractPlytixProduct(plytixProduct, mainProduct)
        enrichedFromPlytix = !!plytixProduct
      } catch (plytixErr) {
        // Non-fatal: log and continue with request body data
        console.error('[create-quote] Plytix enrichment failed:', plytixErr.message)
      }
    }

    // ── Accessories from lib/accessories.js (if not supplied in body) ──
    if (availableAccessories === null && mainSku) {
      availableAccessories = getAccessoriesForSku(mainSku)
    }
    availableAccessories = availableAccessories || []

    // ── Insert quote ───────────────────────────────────────────────────
    const token = randomBytes(16).toString('hex')
    const validUntil = new Date()
    validUntil.setDate(validUntil.getDate() + valid_days)

    const { data: quote, error } = await adminClient.from('quotes').insert({
      token,
      shopify_order_id: shopify_draft_order_id,
      type:              req.body.type     || 'dealer',
      lang:              req.body.lang     || 'da',
      category:          req.body.category || 'other',
      status:            'sent',
      sender_name:       req.body.sender_name    || '',
      sender_email:      req.body.sender_email   || process.env.DEFAULT_SENDER_EMAIL,
      sender_phone:      req.body.sender_phone   || '',
      recipient_name:    req.body.recipient_name    || '',
      recipient_company: req.body.recipient_company || '',
      recipient_email:   req.body.recipient_email   || '',
      recipient_phone:   req.body.recipient_phone   || '',
      dealer_name:       req.body.dealer_name  || '',
      dealer_email:      req.body.dealer_email || '',
      main_product:      mainProduct,
      line_items:        req.body.line_items || [],
      available_accessories: availableAccessories,
      notes:             req.body.notes || '',
      valid_until:       validUntil.toISOString().split('T')[0],
    }).select().single()

    if (error) throw new Error(`Supabase error: ${error.message}`)

    const baseUrl  = process.env.NEXT_PUBLIC_BASE_URL
    const quoteUrl = `${baseUrl}/quote/${token}`

    return res.status(200).json({
      success: true,
      token,
      quote_url:           quoteUrl,
      customer_url:        `${quoteUrl}?view=customer`,
      enriched_from_plytix: enrichedFromPlytix,
    })
  } catch (err) {
    console.error('create-quote error:', err)
    return res.status(500).json({ error: err.message })
  }
}
