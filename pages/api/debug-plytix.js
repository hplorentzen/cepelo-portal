const PLYTIX_AUTH_URL = 'https://auth.plytix.com/auth/api/get-token'
const PLYTIX_BASE     = 'https://pim.plytix.com/api/v1'

export default async function handler(req, res) {
  const { sku = 'CEP028' } = req.query

  const apiKey      = process.env.PLYTIX_API_KEY
  const apiPassword = process.env.PLYTIX_API_PASSWORD
  const result      = { sku, apiKeySet: !!apiKey, apiPasswordSet: !!apiPassword }

  if (!apiKey || !apiPassword) {
    return res.status(200).json({ ...result, step: 'missing_env_vars' })
  }

  // Step 1: auth
  let token
  try {
    const authRes = await fetch(PLYTIX_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, api_password: apiPassword }),
    })
    const authBody = await authRes.json()
    result.authStatus = authRes.status
    result.authBody   = JSON.stringify(authBody).slice(0, 200)
    token = authBody?.data?.[0]?.access_token
    result.tokenReceived = !!token
  } catch (e) {
    return res.status(200).json({ ...result, step: 'auth_threw', error: e.message })
  }

  if (!token) return res.status(200).json({ ...result, step: 'no_token' })

  // Step 2: search by SKU
  try {
    const searchRes = await fetch(`${PLYTIX_BASE}/products/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ filters: [[{ field: 'sku', operator: 'eq', value: sku }]], pagination: { page: 1, page_size: 1 } }),
    })
    const searchBody = await searchRes.json()
    result.searchStatus = searchRes.status
    result.searchHits   = searchBody?.data?.length ?? 0
    result.searchBody   = JSON.stringify(searchBody).slice(0, 300)
    const hit = searchBody?.data?.[0]
    result.productId    = hit?.id ?? null

    // Step 3: product detail
    if (hit?.id) {
      const detailRes  = await fetch(`${PLYTIX_BASE}/products/${hit.id}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      const detailBody = await detailRes.json()
      result.detailStatus = detailRes.status
      result.attributes   = detailBody?.data?.attributes ?? {}
      result.label        = detailBody?.data?.label
    }
  } catch (e) {
    return res.status(200).json({ ...result, step: 'search_threw', error: e.message })
  }

  return res.status(200).json({ ...result, step: 'done' })
}
