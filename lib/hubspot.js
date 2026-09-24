// lib/hubspot.js
// HubSpot CRM API helpers — server-side only (never import in browser code).
//
// Uses:
//   CRM v3: deals, companies, contacts, notes
//   CRM v4: associations
//   Files v3: PDF upload
//   Engagements v1: notes (supports file attachments)
//
// Required HubSpot private-app scopes:
//   crm.objects.deals.read/write, crm.objects.companies.read,
//   crm.objects.contacts.read, crm.objects.owners.read, files

const HS = 'https://api.hubapi.com'

function tok() {
  const t = process.env.HUBSPOT_ACCESS_TOKEN
  if (!t) throw new Error('HUBSPOT_ACCESS_TOKEN not configured')
  return t
}

async function hs(method, path, body) {
  const resp = await fetch(`${HS}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok()}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '')
    throw new Error(`HubSpot ${method} ${path} → ${resp.status}: ${txt.slice(0, 300)}`)
  }
  if (resp.status === 204) return null
  return resp.json()
}

const hsGet   = path      => hs('GET',   path)
const hsPost  = (p, b)   => hs('POST',  p, b)
const hsPatch = (p, b)   => hs('PATCH', p, b)
const hsPut   = (p, b)   => hs('PUT',   p, b)

// ─── Owners (module-level cache, reset per cold start) ────────────────────────
let _owners    = null
let _ownersTtl = 0
const OWNERS_TTL = 5 * 60 * 1000

export async function getAllOwners() {
  if (_owners && Date.now() < _ownersTtl) return _owners
  const d = await hsGet('/crm/v3/owners?limit=200')
  _owners    = d.results || []
  _ownersTtl = Date.now() + OWNERS_TTL
  return _owners
}

export async function getOwnerByEmail(email) {
  if (!email) return null
  const norm = email.trim().toLowerCase()
  const all  = await getAllOwners()
  return all.find(o => (o.email || '').toLowerCase() === norm) ?? null
}

// ─── Deal stage display labels ────────────────────────────────────────────────
export const STAGE_LABELS = {
  appointmentscheduled:  'Ny/uafklaret',
  qualifiedtobuy:        'Kvalificeret',
  presentationscheduled: 'Behov afdækket',
  decisionmakerboughtin: 'Tilbud sendt',
  '5049481439':          'Tilbud gennemgået',
  '5049481440':          'Forhandling',
  closedwon:             'Lukket vundet',
  closedlost:            'Lukket tabt',
}

const CLOSED_STAGES = ['closedwon', 'closedlost']
const EARLY_STAGES  = ['appointmentscheduled', 'qualifiedtobuy', 'presentationscheduled']

const DEAL_PROPS = [
  'dealname', 'amount', 'dealstage', 'hubspot_owner_id',
  'hs_lastmodifieddate', 'pipeline',
]

// ─── Deals ────────────────────────────────────────────────────────────────────
// Fetch ALL open deals with cursor pagination (handles >200 deals).
// No pipeline filter — returns open deals across all pipelines.
export async function searchAllOpenDeals() {
  const all = []
  let after = undefined

  do {
    const data = await hsPost('/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [
        { propertyName: 'dealstage', operator: 'NOT_IN', values: CLOSED_STAGES },
      ]}],
      properties: DEAL_PROPS,
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
      limit: 200,
      ...(after ? { after } : {}),
    })
    all.push(...(data.results || []))
    console.log(`[hubspot/searchAllOpenDeals] page: ${data.results?.length ?? 0}, total so far: ${all.length}`)
    after = data.paging?.next?.after ?? null
  } while (after)

  return all
}

// Batch-fetch company names for a list of deal IDs.
// Returns Map<dealId string, string[]> (company names per deal).
export async function getDealCompanyNames(dealIds) {
  if (!dealIds.length) return new Map()

  // Chunk into 100s (HubSpot batch limit)
  const chunks = []
  for (let i = 0; i < dealIds.length; i += 100) chunks.push(dealIds.slice(i, i + 100))

  const allAssocs = []
  for (const chunk of chunks) {
    const resp = await hsPost('/crm/v4/associations/deals/companies/batch/read', {
      inputs: chunk.map(id => ({ id: String(id) })),
    })
    allAssocs.push(...(resp.results || []))
  }

  const allCompanyIds = new Set()
  const dealToCompanyIds = new Map()
  for (const r of allAssocs) {
    const coIds = (r.to || []).map(t => String(t.toObjectId))
    dealToCompanyIds.set(String(r.from.id), coIds)
    coIds.forEach(id => allCompanyIds.add(id))
  }

  if (!allCompanyIds.size) return new Map(dealIds.map(id => [String(id), []]))

  const coIdArr = [...allCompanyIds]
  const coChunks = []
  for (let i = 0; i < coIdArr.length; i += 100) coChunks.push(coIdArr.slice(i, i + 100))

  const companyNames = new Map()
  for (const chunk of coChunks) {
    const resp = await hsPost('/crm/v3/objects/companies/batch/read', {
      properties: ['name'],
      inputs: chunk.map(id => ({ id })),
    })
    for (const co of resp.results || []) companyNames.set(String(co.id), co.properties?.name || '')
  }

  return new Map(dealIds.map(id => {
    const strId = String(id)
    const coIds = dealToCompanyIds.get(strId) || []
    return [strId, coIds.map(cId => companyNames.get(cId)).filter(Boolean)]
  }))
}

export async function searchOpenDeals(q, { limit = 150 } = {}) {
  const filters = [
    { propertyName: 'pipeline',    operator: 'EQ',     value: 'default' },
    { propertyName: 'dealstage',   operator: 'NOT_IN', values: CLOSED_STAGES },
  ]
  if (q) filters.push({ propertyName: 'dealname', operator: 'CONTAINS_TOKEN', value: q })

  const data = await hsPost('/crm/v3/objects/deals/search', {
    filterGroups: [{ filters }],
    properties: DEAL_PROPS,
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
    limit,
  })
  return data.results || []
}

export async function getDeal(id) {
  const qs = DEAL_PROPS.map(p => `properties=${encodeURIComponent(p)}`).join('&')
  return hsGet(`/crm/v3/objects/deals/${id}?${qs}`)
}

export async function createDeal({ name, amount, ownerId, pipeline = 'default', dealstage = 'decisionmakerboughtin' }) {
  return hsPost('/crm/v3/objects/deals', {
    properties: {
      dealname:  name,
      pipeline,
      dealstage,
      ...(amount != null && { amount: String(Math.round(Number(amount))) }),
      ...(ownerId && { hubspot_owner_id: String(ownerId) }),
    },
  })
}

export async function updateDeal(id, { amount, dealstage }) {
  const props = {}
  if (amount    != null) props.amount    = String(Math.round(Number(amount)))
  if (dealstage)         props.dealstage = dealstage
  if (!Object.keys(props).length) return null
  return hsPatch(`/crm/v3/objects/deals/${id}`, { properties: props })
}

// ─── Companies / contacts ─────────────────────────────────────────────────────
export async function findCompany({ name, domain } = {}) {
  if (domain) {
    const d = await hsPost('/crm/v3/objects/companies/search', {
      filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'EQ', value: domain }] }],
      properties: ['name', 'domain'], limit: 1,
    })
    if (d.results?.length) return d.results[0]
  }
  if (name) {
    const d = await hsPost('/crm/v3/objects/companies/search', {
      filterGroups: [{ filters: [{ propertyName: 'name', operator: 'CONTAINS_TOKEN', value: name }] }],
      properties: ['name', 'domain'], limit: 1,
    })
    if (d.results?.length) return d.results[0]
  }
  return null
}

export async function findContact(email) {
  if (!email) return null
  const d = await hsPost('/crm/v3/objects/contacts/search', {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['email', 'firstname', 'lastname'], limit: 1,
  })
  return d.results?.[0] ?? null
}

// ─── Associations (v4) ────────────────────────────────────────────────────────
export async function associateDealToCompany(dealId, companyId) {
  return hsPut(`/crm/v4/objects/deals/${dealId}/associations/companies/${companyId}`,
    [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 5 }])
}

export async function associateDealToContact(dealId, contactId) {
  return hsPut(`/crm/v4/objects/deals/${dealId}/associations/contacts/${contactId}`,
    [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }])
}

// ─── Notes (v1 Engagements — supports file attachments) ──────────────────────
export async function createDealNote(dealId, noteHtml, { fileIds = [] } = {}) {
  return hsPost('/engagements/v1/engagements', {
    engagement:  { active: true, type: 'NOTE', timestamp: Date.now() },
    associations: { dealIds: [Number(dealId)] },
    metadata:    { body: noteHtml },
    ...(fileIds.length > 0 && { attachments: fileIds.map(id => ({ id })) }),
  })
}

// ─── File upload (v3) ─────────────────────────────────────────────────────────
export async function uploadPdf(buffer, filename) {
  const boundary = `hsf${Date.now()}`
  const nl  = '\r\n'
  const opts = JSON.stringify({
    access: 'PRIVATE', overwrite: false,
    duplicateValidationStrategy: 'NONE', duplicateValidationScope: 'EXACT_FOLDER',
  })

  const preamble = Buffer.from([
    `--${boundary}${nl}Content-Disposition: form-data; name="folderPath"${nl}${nl}/quote-pdfs${nl}`,
    `--${boundary}${nl}Content-Disposition: form-data; name="options"${nl}${nl}${opts}${nl}`,
    `--${boundary}${nl}Content-Disposition: form-data; name="file"; filename="${filename}"${nl}Content-Type: application/pdf${nl}${nl}`,
  ].join(''))
  const epilogue = Buffer.from(`${nl}--${boundary}--${nl}`)
  const body     = Buffer.concat([preamble, buffer, epilogue])

  const resp = await fetch(`${HS}/files/v3/files`, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${tok()}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  })
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '')
    throw new Error(`HubSpot file upload ${resp.status}: ${txt.slice(0, 200)}`)
  }
  return resp.json()
}

// ─── High-level: sync quote on send ──────────────────────────────────────────
//
// Call this fire-and-forget from submit-seller-form.js.
// Returns the finalised HubSpot deal ID (string) or throws on fatal error.
//
export async function syncQuoteOnSend({
  // Deal selection (from form)
  dealId,          // string | null  — existing deal; null → create new
  isNewDeal,       // boolean
  newDealName,     // string         — name for newly created deal

  // Quote identifiers
  quoteRef,        // e.g. '#D5374'
  quoteToken,      // dealer token (for PDF URL)
  senderEmail,     // CEPELO seller email (for owner lookup)
  type,            // 'dealer' | 'customer'

  // Pricing
  totalNet,        // total net amount (number, excl. VAT)

  // People / companies
  dealerName,
  recipientCompany,
  recipientEmail,

  // Products for note body
  products,        // [{name, quantity, net_price}]

  // URLs
  baseUrl,
  quoteUrl,
  customerUrl,
}) {
  let finalDealId = dealId || null

  // ── 1. Create or update the deal ─────────────────────────────────────────────
  if (isNewDeal) {
    const owner = await getOwnerByEmail(senderEmail).catch(() => null)
    const deal  = await createDeal({
      name:      newDealName || `${dealerName || 'Kunde'} – ${quoteRef || 'tilbud'}`,
      amount:    totalNet,
      ownerId:   owner?.id,
      pipeline:  'default',
      dealstage: 'decisionmakerboughtin',
    })
    finalDealId = deal.id
    console.log(`[hubspot] Created deal ${finalDealId}`)

    // Associate companies + contact (fire-and-forget each; don't create if not found)
    if (dealerName) {
      findCompany({ name: dealerName })
        .then(co => {
          if (co) return associateDealToCompany(finalDealId, co.id)
          console.log(`[hubspot] Dealer company "${dealerName}" not found in HubSpot`)
        })
        .catch(e => console.warn('[hubspot] Associate dealer company:', e.message))
    }
    if (recipientCompany) {
      findCompany({ name: recipientCompany })
        .then(co => {
          if (co) return associateDealToCompany(finalDealId, co.id)
          console.log(`[hubspot] Customer company "${recipientCompany}" not found in HubSpot`)
        })
        .catch(e => console.warn('[hubspot] Associate customer company:', e.message))
    }
    if (recipientEmail) {
      findContact(recipientEmail)
        .then(ct => {
          if (ct) return associateDealToContact(finalDealId, ct.id)
          console.log(`[hubspot] Contact "${recipientEmail}" not found in HubSpot`)
        })
        .catch(e => console.warn('[hubspot] Associate contact:', e.message))
    }

  } else if (finalDealId) {
    // Update amount; advance stage only if it's at an early stage
    const current      = await getDeal(finalDealId)
    const currentStage = current.properties?.dealstage
    const advanceStage = EARLY_STAGES.includes(currentStage)

    await updateDeal(finalDealId, {
      amount:   totalNet,
      ...(advanceStage && { dealstage: 'decisionmakerboughtin' }),
    })
    console.log(`[hubspot] Updated deal ${finalDealId} (stage advanced: ${advanceStage})`)
  }

  if (!finalDealId) return null

  // ── 2. Generate and upload PDF ────────────────────────────────────────────────
  let fileIds = []
  try {
    const pdfResp = await fetch(`${baseUrl}/api/generate-pdf?token=${quoteToken}`)
    if (pdfResp.ok) {
      const buf    = Buffer.from(await pdfResp.arrayBuffer())
      const file   = await uploadPdf(buf, `tilbud-${(quoteRef || 'tilbud').replace(/[^a-z0-9]/gi, '')}.pdf`)
      if (file?.id) { fileIds = [file.id]; console.log(`[hubspot] PDF uploaded id=${file.id}`) }
    }
  } catch (pdfErr) {
    console.warn('[hubspot] PDF upload failed (non-fatal):', pdfErr.message)
  }

  // ── 3. Create note on deal ────────────────────────────────────────────────────
  const typeLabel    = type === 'customer' ? 'Slutkundetilbud' : 'Forhandlertilbud'
  const fmtAmount    = Math.round(totalNet).toLocaleString('da-DK') + ' kr'
  const portalUrl    = type === 'customer' ? customerUrl : quoteUrl
  const pdfUrl       = `${baseUrl}/api/generate-pdf?token=${quoteToken}`

  const productLines = products
    .filter(p => p.sku !== 'DELIVERY' && p.type !== 'discount')
    .map(p => {
      const name = typeof p.name === 'object' ? (p.name?.da || p.name?.en || p.sku || '') : (p.name || p.sku || '')
      const qty  = (p.quantity || 1) > 1 ? ` × ${p.quantity}` : ''
      const net  = p.net_price > 0 ? ` — netto ${Math.round(p.net_price).toLocaleString('da-DK')} kr` : ''
      return `• ${name}${qty}${net}`
    })
    .join('<br>')

  const noteHtml = [
    `<b>Tilbud ${quoteRef || ''} sendt til ${dealerName || 'forhandler'}</b>`,
    `<b>Type:</b> ${typeLabel}`,
    `<b>Beløb (netto ekskl. moms):</b> ${fmtAmount}`,
    `<br><b>Produkter:</b><br>${productLines}`,
    `<br><a href="${portalUrl}">📄 Se tilbud i portalen</a>`,
    `<a href="${pdfUrl}">⬇ Download PDF</a>`,
  ].join('<br>')

  await createDealNote(finalDealId, noteHtml, { fileIds })
  console.log(`[hubspot] Note created on deal ${finalDealId}`)

  return String(finalDealId)
}

// ─── High-level: note on quote acceptance ─────────────────────────────────────
export async function noteQuoteAccepted({ dealId, quoteRef, recipientName, recipientCompany }) {
  if (!dealId) return
  const when = new Date().toLocaleDateString('da-DK', { day: '2-digit', month: 'long', year: 'numeric' })
  const who  = [recipientName, recipientCompany].filter(Boolean).join(', ')
  const body = `Tilbud ${quoteRef || ''} accepteret${who ? ` af ${who}` : ''} – ${when}`
  return createDealNote(dealId, body)
}
