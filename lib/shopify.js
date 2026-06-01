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

// Storefront: fetch multiple products by GID array (for metafield accessories)
const PRODUCTS_BY_IDS_QUERY = `
  query ProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
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
    video_url:        null,   // populated separately by fetchProductBySku
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

  const variantPrice = parseFloat(variant.price?.amount || 0)
  const compareAt    = parseFloat(variant.compareAtPrice?.amount || 0)

  // net_price  = variant.price  (what CEPELO charges the dealer)
  // gross_price = initial estimate until vejl_udsalgspris metafield overrides it:
  //   • compareAtPrice  if it is higher than variant.price (likely the retail price)
  //   • otherwise       35% markup on variant.price as a rough stand-in
  const netPrice   = Math.round(variantPrice)
  const grossPrice = compareAt > variantPrice
    ? Math.round(compareAt)
    : Math.round(variantPrice * 1.35)

  return {
    sku:         variant.sku,
    type:        'product',
    name:        { da: node.title, en: node.title },
    description: {},
    net_price:   netPrice,
    gross_price: grossPrice,
    compare_at:  compareAt > 0 ? Math.round(compareAt) : null,
    currency:    variant.price?.currencyCode || 'DKK',
    image_url:   images[0]?.url || null,
    available:   variant.availableForSale,
    shopify_product_id: node.id,
    shopify_handle:     node.handle,
  }
}

// ---------------------------------------------------------------------------
// Admin API: Metafields helpers
// ---------------------------------------------------------------------------

/** Extract the trailing numeric ID from a Shopify GID, e.g. "gid://shopify/Product/12345" → "12345" */
function gidToNumericId(gid) {
  if (!gid) return null
  return gid.split('/').pop() ?? null
}

/**
 * Resolve a Shopify Video GID (e.g. "gid://shopify/Video/12345") to a CDN URL
 * using the Admin GraphQL API — files.json returns 404 for Video GIDs.
 * Returns the mp4 URL (or first available source), or null on any error.
 */
async function resolveVideoGid(gid) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN || 'cepelotools.myshopify.com'
  const token  = process.env.SHOPIFY_ADMIN_TOKEN
  if (!token) return null

  const query = `{
    node(id: "${gid}") {
      ... on Video {
        sources { url mimeType }
      }
    }
  }`

  try {
    const res = await fetch(`https://${domain}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
      method:  'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query }),
    })
    if (!res.ok) {
      console.warn(`[shopify/video] Admin GraphQL HTTP ${res.status} for GID ${gid}`)
      return null
    }
    const json = await res.json()
    console.log('[shopify/video] Admin GraphQL response:', JSON.stringify(json).slice(0, 400))

    const sources = json?.data?.node?.sources
    if (!sources?.length) {
      console.warn(`[shopify/video] no sources in GraphQL response for GID ${gid}`)
      return null
    }

    const mp4 = sources.find(s => s.mimeType === 'video/mp4')
    const resolved = (mp4 || sources[0]).url
    console.log('[shopify/video] resolved URL:', resolved)
    return resolved
  } catch (e) {
    console.warn(`[shopify/video] resolveVideoGid error for ${gid}:`, e.message)
    return null
  }
}

/**
 * Fetch all raw metafields for a product via Admin REST API.
 * Returns the metafields array, or [] on any error (token missing, 4xx, etc.).
 */
async function fetchRawMetafields(numericId) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN || 'cepelotools.myshopify.com'
  const token  = process.env.SHOPIFY_ADMIN_TOKEN
  if (!token) {
    console.warn('[shopify/metafields] SHOPIFY_ADMIN_TOKEN not set — skipping metafields')
    return []
  }
  const url = `https://${domain}/admin/api/${ADMIN_API_VERSION}/products/${numericId}/metafields.json`
  const res = await fetch(url, {
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  })
  if (!res.ok) {
    console.warn(`[shopify/metafields] HTTP ${res.status} for product ${numericId}`)
    return []
  }
  const { metafields } = await res.json()
  const mfArray = Array.isArray(metafields) ? metafields : []
  console.log('[video] all metafields for', numericId, ':', JSON.stringify(mfArray.map(m => ({ns: m.namespace, key: m.key, type: m.type}))))
  return mfArray
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a product from Shopify by variant SKU.
 * Returns a normalised product object, or null if no exact SKU match found.
 *
 * NOTE: The Storefront API products(query:) is a consumer full-text search —
 * it does NOT support structured field filters like "variants.sku:SKU" or
 * "sku:SKU". Those prefixes are silently ignored and the search falls back
 * to full-text, returning wrong products. The correct approach is to search
 * with the bare SKU string and then validate via exact variant match.
 */
export async function fetchProductBySku(sku) {
  const data    = await storefrontQuery(PRODUCT_BY_SKU_QUERY, { query: sku })
  const node    = data?.products?.edges?.[0]?.node ?? null
  const product = normaliseProduct(node, sku)
  if (!product) return null

  // Enrich gross_price and video_url from Admin API metafields.
  // Wrapped entirely in try/catch — a failure here must never affect
  // image_url, gross_price (Storefront fallback), or any other core field.
  const numericId = gidToNumericId(node.id)
  if (numericId) {
    try {
      const metafields = await fetchRawMetafields(numericId)

      // 1. gross_price: "vejl_udsalgspris_ekskl_moms_dkk" = Danish retail price excl VAT
      const grossMf = metafields.find(
        m => m.namespace === 'custom' && m.key === 'vejl_udsalgspris_ekskl_moms_dkk'
      )
      if (grossMf?.value) {
        const v = parseFloat(String(grossMf.value).replace(',', '.'))
        if (!isNaN(v) && v > 0) {
          product.gross_price = Math.round(v)
          console.log(`[shopify/metafields] gross_price for ${sku}: ${product.gross_price} (from metafield)`)
        }
      }

      // 2. video_url: "productvideo" file metafield (namespace: custom or global)
      const videoMf = metafields.find(m => m.key === 'productvideo')
      console.log('[video] productvideo metafield:', JSON.stringify(videoMf))

      if (videoMf?.value) {
        const val = String(videoMf.value)
        if (val.startsWith('http')) {
          // Direct CDN URL stored in metafield
          product.video_url = val
          console.log(`[shopify/video] direct HTTP URL for ${sku}: ${val}`)
        } else if (val.startsWith('gid://')) {
          // File/Video GID — resolve via Admin GraphQL node query
          const resolvedUrl = await resolveVideoGid(val)
          if (resolvedUrl) {
            product.video_url = resolvedUrl
            console.log(`[shopify/video] resolved video_url for ${sku}: ${resolvedUrl}`)
          }
        }
      }
    } catch (e) {
      console.warn(`[shopify/metafields] enrichment failed for ${sku}:`, e.message)
    }
  }

  console.log('[video] final video_url for', sku, ':', product.video_url)
  return product
}

/**
 * Fetch Shopify product recommendations for a product GID.
 * Returns an array of normalised accessory-shaped objects (may be empty).
 */
export async function fetchProductRecommendations(productGid) {
  const data  = await storefrontQuery(RECOMMENDATIONS_QUERY, { productId: productGid })
  const nodes = data?.productRecommendations ?? []
  return nodes.map(normaliseRecommendation).filter(Boolean)
}

/**
 * Fetch accessories from Admin API metafields (list.product_reference and
 * product_reference types — covers "Related products" and "Complementary
 * products" regardless of their exact metafield key).
 *
 * @param {string} productGid  e.g. "gid://shopify/Product/15263893324154"
 * @returns {Promise<Array>}   normalised accessory objects, may be empty
 */
export async function fetchAccessoriesFromMetafields(productGid) {
  const numericId = gidToNumericId(productGid)
  if (!numericId) return []

  let metafields
  try {
    metafields = await fetchRawMetafields(numericId)
  } catch (e) {
    console.warn('[shopify/metafields] fetchAccessoriesFromMetafields failed:', e.message)
    return []
  }

  // Log ALL metafield keys+types so we can identify the right product-reference field names
  // in Vercel logs (especially for ADAS / other products that have related products).
  const allMfSummary = metafields.map(m => `${m.namespace}.${m.key}(${m.type})`).join(', ') || '(none)'
  console.log(`[shopify/acc-refs] product ${numericId}: ${metafields.length} metafields — ${allMfSummary}`)

  // Collect all product GIDs from every product_reference metafield
  const gids = []
  for (const mf of metafields) {
    if (mf.type === 'list.product_reference') {
      try {
        const refs = JSON.parse(mf.value)
        if (Array.isArray(refs)) {
          const productRefs = refs.filter(r => typeof r === 'string' && r.startsWith('gid://shopify/Product/'))
          gids.push(...productRefs)
          console.log(`[shopify/metafields] "${mf.namespace}.${mf.key}" → ${productRefs.length} product refs`)
        }
      } catch {}
    } else if (
      mf.type === 'product_reference' &&
      typeof mf.value === 'string' &&
      mf.value.startsWith('gid://shopify/Product/')
    ) {
      gids.push(mf.value)
      console.log(`[shopify/metafields] "${mf.namespace}.${mf.key}" → 1 product ref`)
    }
  }

  if (gids.length === 0) {
    console.log(`[shopify/metafields] No product_reference metafields found for ${productGid}`)
    return []
  }

  const uniqueGids = [...new Set(gids)]
  console.log(`[shopify/metafields] Fetching ${uniqueGids.length} accessory products via Storefront nodes query`)

  try {
    const data  = await storefrontQuery(PRODUCTS_BY_IDS_QUERY, { ids: uniqueGids })
    const nodes = (data?.nodes ?? []).filter(n => n && n.id) // filter out null / non-Product nodes
    const accessories = nodes.map(normaliseRecommendation).filter(Boolean)
    console.log(`[shopify/metafields] ${accessories.length} accessories normalised`)

    // Enrich each accessory's gross_price from Admin metafields (vejl_udsalgspris_ekskl_moms_dkk)
    // Done in parallel to minimise latency; on failure gross_price stays at compareAt or ×1.35 estimate.
    const enriched = await Promise.all(
      accessories.map(async acc => {
        const numericId = gidToNumericId(acc.shopify_product_id)
        if (!numericId) {
          console.warn(`[shopify/acc] ${acc.sku}: no numericId from GID "${acc.shopify_product_id}"`)
          console.log('[acc]', acc.sku, 'net=', acc.net_price, 'gross=', acc.gross_price, '(source: estimate/noGID)')
          return acc
        }
        try {
          const metafields = await fetchRawMetafields(numericId)
          const grossMf = metafields.find(
            m => m.namespace === 'custom' && m.key === 'vejl_udsalgspris_ekskl_moms_dkk'
          )
          if (grossMf?.value) {
            const v = parseFloat(String(grossMf.value).replace(',', '.'))
            if (!isNaN(v) && v > 0) {
              console.log('[acc]', acc.sku, 'net=', acc.net_price, 'gross=', Math.round(v), '(source: vejl metafield)')
              return { ...acc, gross_price: Math.round(v) }
            }
            console.warn(`[shopify/acc] ${acc.sku}: vejl metafield value "${grossMf.value}" unusable`)
          }
          // vejl metafield missing or unusable — log what IS present
          const mfKeys = metafields.map(m => `${m.namespace}.${m.key}`).join(', ') || '(none)'
          const source = (acc.compare_at && acc.gross_price === acc.compare_at) ? 'compareAt' : 'x1.35 estimate'
          console.log('[acc]', acc.sku, 'net=', acc.net_price, 'gross=', acc.gross_price, `(source: ${source} — vejl not in [${mfKeys}])`)
        } catch (e) {
          console.warn(`[shopify/acc] ${acc.sku}: metafield fetch failed — ${e.message}`)
          console.log('[acc]', acc.sku, 'net=', acc.net_price, 'gross=', acc.gross_price, '(source: estimate/error)')
        }
        return acc
      })
    )
    return enriched
  } catch (e) {
    console.warn('[shopify/metafields] Storefront nodes query failed:', e.message)
    return []
  }
}

// ---------------------------------------------------------------------------
// Admin API: Draft Order lookup
// ---------------------------------------------------------------------------

const ADMIN_API_VERSION = '2024-01'

/**
 * Fetch a Shopify draft order by its order name reference (e.g. "#D4760").
 *
 * The Admin REST API does not support filtering by name directly, so we list
 * draft orders by status and match client-side. We check open → invoice_sent
 * → completed to cover all likely states with short-circuit on first match.
 *
 * Requires SHOPIFY_ADMIN_TOKEN (atkn_ format) in env vars.
 * Returns the raw Shopify draft order object, or null if not found.
 */
export async function fetchDraftOrderByRef(orderRef) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN || 'cepelotools.myshopify.com'
  const token  = process.env.SHOPIFY_ADMIN_TOKEN
  if (!token) throw new Error('SHOPIFY_ADMIN_TOKEN not configured')

  // Normalise to "#DXXXX" format
  const name   = orderRef.startsWith('#') ? orderRef : `#${orderRef}`
  const FIELDS = 'id,name,status,note,currency,subtotal_price,total_price,line_items,shipping_line,applied_discount,customer,shipping_address'

  async function fetchByStatus(status) {
    const url        = `https://${domain}/admin/api/${ADMIN_API_VERSION}/draft_orders.json?status=${status}&limit=250&fields=${FIELDS}`
    const controller = new AbortController()
    const tid        = setTimeout(() => controller.abort(), 10_000) // 10 s hard limit

    let resp
    try {
      resp = await fetch(url, {
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        signal:  controller.signal,
      })
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error(`Shopify Admin API timed out after 10 s (status=${status})`)
      }
      throw e
    } finally {
      clearTimeout(tid)
    }

    if (resp.status === 401) {
      throw new Error(
        'Shopify Admin API returned 401 Unauthorized — ' +
        'SHOPIFY_ADMIN_TOKEN is invalid, revoked, or missing the read_draft_orders scope. ' +
        'Regenerate the token in Shopify Admin → Apps → your custom app.'
      )
    }
    if (!resp.ok) {
      const body = await resp.text()
      throw new Error(`Shopify Admin API ${resp.status}: ${body.slice(0, 200)}`)
    }

    const { draft_orders } = await resp.json()
    return (draft_orders || []).find(o => o.name === name) || null
  }

  return (await fetchByStatus('open'))
      || (await fetchByStatus('invoice_sent'))
      || (await fetchByStatus('completed'))
}
