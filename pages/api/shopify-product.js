// pages/api/shopify-product.js
// Fetches product data by SKU from the Shopify Storefront API.
// All Shopify logic lives in lib/shopify.js.
//
// Usage: GET /api/shopify-product?sku=IT25
//
// Env vars (see lib/shopify.js for details):
//   SHOPIFY_STORE_DOMAIN        e.g. cepelotools.myshopify.com  (has default)
//   SHOPIFY_STOREFRONT_TOKEN    optional — tokenless reads work for public data

import { fetchProductBySku } from '../../lib/shopify'

export default async function handler(req, res) {
  const sku = req.query.sku || req.body?.sku
  if (!sku) return res.status(400).json({ error: 'Pass ?sku=...' })

  try {
    const product = await fetchProductBySku(sku)
    if (!product) return res.status(404).json({ error: `No product found for SKU: ${sku}` })
    return res.status(200).json({ product })
  } catch (err) {
    console.error('[shopify-product]', err.message)
    return res.status(500).json({ error: err.message })
  }
}
