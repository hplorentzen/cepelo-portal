// lib/shopify.js
// Shopify Storefront API helpers shared across API routes.
//
// Token is optional — Shopify allows unauthenticated reads up to 1 000 query
// complexity. A single-product-by-SKU lookup costs ~15 points, and product
// recommendations cost ~50 points, so both work token-free.
//
// Set SHOPIFY_STOREFRONT_TOKEN in Vercel env vars to lift the rate-limit and
// unlock higher query complexity budgets when needed.

const STOREFRONT_API_VERSION = '2024-01'

// ---------------------------------------------------------------------------
// Internal HTTP helper
// ---------------------------------------------------------------------------

async function storefrontQuery(query, variables = {}) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN || 'cepelotools.myshopify.com'
  const token  = process.env.SHOPIFY_STOREFRONT_TOKEN

  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['X-Shopify-Storefront-Access-Token'] = token

  const res  = await fetch(
    `https://${domain}/api/${STOREFRONT_API_VERSION}/graphql.json`,
    { method: 'POST', headers, body: JSON.stringify({ query, variables }) }
  )
  const json = await res.json()
  if (json.errors) throw new Error(json.errors[0]?.message || 'Shopify GraphQL error')
  return json.data
}

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

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
            edges { node { url altText } }
          }
          variants(first: 20) {
            edges {
              node {
                id
                sku
                title
                availableForSale
                price { amount currencyCode }
                compareAtPrice { amount currencyCode }
              }
            }
          }
        }
      }
    }
  }
`

const RECOMMENDATIONS_QUERY = `
  query ProductRecommendations($productId: ID!) {
    productRecommendations(productId: $productId) {
      id
      title
      handle
      vendor
      productType
      images(first: 1) {
        edges { node { url altText } }
      }
      variants(first: 1) {
        edges {
          node {
            sku
            availableForSale
            price { amount currencyCode }
            compareAtPrice { amount currencyCode }
          }
        }
      }
    }
  }
`

// ---------------------------------------------------------------------------
// Normalisers
// ---------------------------------------------------------------------------

function normaliseProduct(node, targetSku) {
  if (!node) return null

  const images   = node.images.edges.map(e => e.node)
  const variants = node.variants.edges.map(e => e.node)

  // Require an exact SKU match — prevents Shopify fuzzy-search false positives
  const variant = variants.find(v => v.sku === targetSku)
  if (!variant) return null

  const grossPrice = parseFloat(variant.price?.amount || 0)
  const compareAt  = parseFloat(variant.compareAtPrice?.amount || 0)
  // compareAtPrice is the "was" / recommended retail price — use as net when present
  const netPrice   = compareAt > 0 ? compareAt : Math.round(grossPrice / 1.35)

  return {
    shopify_product_id: node.id,
    sku:              variant.sku,
    name:             node.title,
    description:      node.description,
    description_html: node.descriptionHtml,
    handle:           node.handle,
    vendor:           node.vendor,
    product_type:     node.productType,
    tags:             node.tags,
    image_url:        images[0]?.url || null,
    images:           images.map(i => ({ url: i.url, alt: i.altText })),
    gross_price:      Math.round(grossPrice),
    net_price:        Math.round(netPrice),
    currency:         variant.price?.currencyCode || 'DKK',
    variants: variants.map(v => ({
      id:          v.id,
      sku:         v.sku,
      title:       v.title,
      gross_price: Math.round(parseFloat(v.price?.amount || 0)),
      compare_at:  v.compareAtPrice ? Math.round(parseFloat(v.compareAtPrice.amount)) : null,
      currency:    v.price?.currencyCode,
      available:   v.availableForSale,
    })),
  }
}

function normaliseRecommendation(node) {
  if (!node) return null
  const images  = node.images.edges.map(e => e.node)
  const variant = node.variants.edges[0]?.node
  if (!variant?.sku) return null

  const grossPrice = parseFloat(variant.price?.amount || 0)
  const compareAt  = parseFloat(variant.compareAtPrice?.amount || 0)

  return {
    sku:         variant.sku,
    type:        'product',
    name:        { da: node.title, en: node.title },
    description: {},
    gross_price: Math.round(grossPrice),
    compare_at:  compareAt > 0 ? Math.round(compareAt) : null,
    currency:    variant.price?.currencyCode || 'DKK',
    image_url:   images[0]?.url || null,
    available:   variant.availableForSale,
    shopify_product_id: node.id,
    shopify_handle:     node.handle,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a product from Shopify by variant SKU.
 * Returns a normalised product object, or null if no exact SKU match found.
 */
export async function fetchProductBySku(sku) {
  const data = await storefrontQuery(PRODUCT_BY_SKU_QUERY, { query: `variants.sku:${sku}` })
  const node = data?.products?.edges?.[0]?.node ?? null
  return normaliseProduct(node, sku)
}

/**
 * Fetch Shopify product recommendations for a product GID
 * (e.g. "gid://shopify/Product/1234567890").
 * Returns an array of normalised accessory-shaped objects (may be empty).
 */
export async function fetchProductRecommendations(productGid) {
  const data  = await storefrontQuery(RECOMMENDATIONS_QUERY, { productId: productGid })
  const nodes = data?.productRecommendations ?? []
  return nodes.map(normaliseRecommendation).filter(Boolean)
}
