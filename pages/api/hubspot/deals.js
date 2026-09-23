// pages/api/hubspot/deals.js
//
// GET /api/hubspot/deals?q=&dealer=&customer=&seller_email=
//
// Returns open HubSpot deals (pipeline=default, not closed), scored by
// relevance to the dealer/customer name and the seller's HubSpot owner.
// The HubSpot token never leaves the server.

import { searchOpenDeals, getAllOwners, STAGE_LABELS } from '../../../lib/hubspot'

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { q = '', dealer = '', customer = '', seller_email = '' } = req.query

  try {
    const [deals, owners] = await Promise.all([
      searchOpenDeals(q || undefined, { limit: 150 }),
      getAllOwners(),
    ])

    // Build owner-id → display-name map
    const ownerMap = Object.fromEntries(
      owners.map(o => [
        String(o.id),
        `${o.firstName || ''} ${o.lastName || ''}`.trim() || o.email || String(o.id),
      ])
    )

    const sellerOwner   = seller_email
      ? owners.find(o => (o.email || '').toLowerCase() === seller_email.toLowerCase())
      : null
    const sellerOwnerId = sellerOwner ? String(sellerOwner.id) : null

    // Words to match against deal names for relevance scoring
    const matchWords = [dealer, customer]
      .filter(Boolean)
      .flatMap(s => s.toLowerCase().split(/\s+/).filter(w => w.length > 3))

    // Score + sort
    const scored = deals.map(d => {
      const name = (d.properties?.dealname || '').toLowerCase()
      let score  = 0
      if (matchWords.length) {
        const hits = matchWords.filter(w => name.includes(w)).length
        if (hits > 0) score += 3 * hits
      }
      if (sellerOwnerId && d.properties?.hubspot_owner_id === sellerOwnerId) score += 2
      return { ...d, _score: score }
    })

    scored.sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score
      return (
        new Date(b.properties?.hs_lastmodifieddate || 0) -
        new Date(a.properties?.hs_lastmodifieddate || 0)
      )
    })

    const result = scored.slice(0, 50).map(d => ({
      id:        d.id,
      name:      d.properties?.dealname || `Deal ${d.id}`,
      stage:     STAGE_LABELS[d.properties?.dealstage] || d.properties?.dealstage || '—',
      amount:    d.properties?.amount ? Number(d.properties.amount) : null,
      ownerName: d.properties?.hubspot_owner_id
        ? (ownerMap[d.properties.hubspot_owner_id] || '—')
        : '—',
      score:     d._score,
    }))

    return res.status(200).json({ deals: result })
  } catch (e) {
    console.error('[hubspot/deals]', e.message)
    // Return empty list on error so the seller form is not blocked
    return res.status(200).json({ deals: [], error: e.message })
  }
}
