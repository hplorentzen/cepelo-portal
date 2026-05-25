// pages/api/shopify-product.js
// Fetches product data by SKU from the Shopify Storefront API (GraphQL).
//
// Required env vars:
//   SHOPIFY_STORE_DOMAIN          e.g. cepelotools.myshopify.com
//   SHOPIFY_STOREFRONT_TOKEN      Storefront API access token (see below)
//
// How to create a Storefront Access Token (no Admin API required):
//   Shopify Admin → Settings → Apps and sales channels → Develop apps
//   → Create/open app → Configuration → Storefront API integration
//   → Enable scopes: unauthenticated_read_product_listings,
//                    unauthenticated_read_product_inventory
//   → Save → API credentials tab → copy "Storefront API access token"

const STOREFRONT_API_VERSION = '2024-01'

const PRODUCT_BY_SKU_QUERY = `
  query ProductBySku($query: String!) {
    products(first: 1, query: $query) {
      edges {
        node {
          id
          title
          description
          descriptionHtml
          handle
          vendor
          productType
          tags
          images(first: 10) {
            edges {
              node {
                url
                altText
              }
            }
          }
          variants(first: 20) {
            edges {
              node {
                id
                sku
                title
                availableForSale
                price {
                  amount
                  currencyCode
                }
                compareAtPrice {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      }
    }
  }
`

function normaliseProduct(node, targetSku) {
  if (!node) return null

  const images   = node.images.edges.map(e => e.node)
  const variants = node.variants.edges.map(e => e.node)

  // Find the exact variant matching the requested SKU, fall back to first
  const variant  = variants.find(v => v.sku === targetSku) || variants[0]

  const grossPrice = parseFloat(variant?.price?.amount || 0)
  const compareAt  = parseFloat(variant?.compareAtPrice?.amount || 0)
  // compareAtPrice is the "was" price; use it as net if present
  const netPrice   = compareAt > 0 ? compareAt : Math.round(grossPrice / 1.35)

  return {
    sku:          variant?.sku || targetSku,
    name:         node.title,
    description:  node.description,
    handle:       node.handle,
    vendor:       node.vendor,
    product_type: node.productType,
    tags:         node.tags,
    image_url:    images[0]?.url || null,
    images:       images.map(i => ({ url: i.url, alt: i.altText })),
    gross_price:  Math.round(grossPrice),
    net_price:    Math.round(netPrice),
    currency:     variant?.price?.currencyCode || 'DKK',
    variants:     variants.map(v => ({
      id:           v.id,
      sku:          v.sku,
      title:        v.title,
      gross_price:  Math.round(parseFloat(v.price?.amount || 0)),
      compare_at:   v.compareAtPrice ? Math.round(parseFloat(v.compareAtPrice.amount)) : null,
      currency:     v.price?.currencyCode,
      available:    v.availableForSale,
    })),
  }
}

export default async function handler(req, res) {
  const sku    = req.query.sku || req.body?.sku
  const domain = process.env.SHOPIFY_STORE_DOMAIN || 'cepelotools.myshopify.com'
  const token  = process.env.SHOPIFY_STOREFRONT_TOKEN

  if (!sku)   return res.status(400).json({ error: 'Pass ?sku=...' })
  if (!token) return res.status(500).json({ error: 'SHOPIFY_STOREFRONT_TOKEN not set' })

  const url = `https://${domain}/api/${STOREFRONT_API_VERSION}/graphql.json`

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type':                    'application/json',
        'X-Shopify-Storefront-Access-Token': token,
      },
      body: JSON.stringify({
        query:     PRODUCT_BY_SKU_QUERY,
        variables: { query: `variants.sku:${sku}` },
      }),
    })

    const json = await response.json()

    if (json.errors) {
      return res.status(502).json({ error: 'Shopify GraphQL error', details: json.errors })
    }

    const node    = json.data?.products?.edges?.[0]?.node ?? null
    const product = normaliseProduct(node, sku)

    if (!product) {
      return res.status(404).json({ error: `No product found for SKU: ${sku}` })
    }

    return res.status(200).json({ product })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
