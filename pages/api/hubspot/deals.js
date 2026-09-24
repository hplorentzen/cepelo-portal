// pages/api/hubspot/deals.js
//
// GET /api/hubspot/deals?seller_email=
//
// Returns ALL open HubSpot deals (default pipeline, not closed) with associated
// company names. Filtering and sorting are done client-side; this endpoint is
// called once on page load, not per keystroke.
// The HubSpot token never leaves the server.

import { searchAllOpenDeals, getAllOwners, getDealCompanyNames } from '../../../lib/hubspot'

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { seller_email = '' } = req.query

  try {
    const [deals, owners] = await Promise.all([
      searchAllOpenDeals(),
      getAllOwners(),
    ])

    const ownerMap = Object.fromEntries(
      owners.map(o => [
        String(o.id),
        `${o.firstName || ''} ${o.lastName || ''}`.trim() || o.email || String(o.id),
      ])
    )

    const sellerOwner = seller_email
      ? owners.find(o => (o.email || '').toLowerCase() === seller_email.toLowerCase())
      : null

    const companyNamesMap = await getDealCompanyNames(deals.map(d => d.id))

    console.log(`[hubspot/deals] raw deals from HubSpot: ${deals.length}, owners: ${owners.length}`)

    const result = deals.map(d => ({
      id:           d.id,
      name:         d.properties?.dealname  || `Deal ${d.id}`,
      dealstage:    d.properties?.dealstage || '',
      amount:       d.properties?.amount ? Number(d.properties.amount) : null,
      ownerId:      d.properties?.hubspot_owner_id || null,
      ownerName:    d.properties?.hubspot_owner_id
        ? (ownerMap[d.properties.hubspot_owner_id] || '—')
        : '—',
      companies:    companyNamesMap.get(String(d.id)) || [],
      lastModified: d.properties?.hs_lastmodifieddate || null,
    }))

    console.log(`[hubspot/deals] returning ${result.length} deals, sellerOwnerId=${sellerOwner?.id || 'none'}`)
    return res.status(200).json({
      deals:         result,
      sellerOwnerId: sellerOwner ? String(sellerOwner.id) : null,
    })
  } catch (e) {
    console.error('[hubspot/deals]', e.message)
    return res.status(500).json({ deals: [], error: e.message })
  }
}
