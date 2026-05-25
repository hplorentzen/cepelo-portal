export default async function handler(req, res) {
  const token  = process.env.SHOPIFY_ADMIN_TOKEN
  const domain = process.env.SHOPIFY_STORE_DOMAIN || 'cepelotools.myshopify.com'

  if (!token) return res.status(500).json({ error: 'SHOPIFY_ADMIN_TOKEN not set' })

  try {
    const response = await fetch(
      `https://${domain}/admin/api/2024-01/draft_orders.json?limit=3`,
      {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
        },
      }
    )

    const body = await response.json()

    return res.status(200).json({
      httpStatus:  response.status,
      statusText:  response.statusText,
      domain,
      tokenSet:    true,
      tokenPrefix: token.slice(0, 8) + '...',
      draftOrders: body.draft_orders?.map(o => ({
        id:         o.id,
        name:       o.name,
        status:     o.status,
        total:      o.total_price,
        created_at: o.created_at,
        customer:   o.customer?.email || o.email || null,
      })) ?? null,
      error: body.errors ?? null,
    })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
