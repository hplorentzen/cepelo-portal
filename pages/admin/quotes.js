// pages/admin/quotes.js
//
// Sales dashboard — lists all quotes ordered newest-first.
// Protected by ?key=<CEPELO_API_SECRET> query param or the login form.
//
// Columns: Dato | Ref | Forhandler | Sælger | Type | Status |
//          Nettopris i alt | Bruttopris i alt | Avance %

import Head from 'next/head'
import { useState } from 'react'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('da-DK', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  })
}

function fmtKr(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('da-DK', {
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(n) + ' kr'
}

function calcTotals(quote) {
  const all = [quote.main_product, ...(quote.line_items || [])].filter(Boolean)
  const items = all.filter(i => i.sku !== 'DELIVERY')

  const net   = Math.round(items.reduce((s, i) => s + (i.net_price   || 0) * (i.quantity || 1), 0))
  const gross = Math.round(items.reduce((s, i) => s + (i.gross_price || 0) * (i.quantity || 1), 0))
  const margin = gross > 0 && net > 0
    ? Math.round((gross - net) / gross * 100)
    : null
  return { net, gross, margin }
}

const STATUS = {
  draft:           { label: 'Kladde',    bg: '#f0f0f2', color: '#767686', border: '#d4d4dc' },
  sent:            { label: 'Sendt',     bg: '#E8F3FC', color: '#0868B2', border: '#baddf5' },
  accepted:        { label: 'Accepteret',bg: '#e8f5e9', color: '#2e7d32', border: '#a5d6a7' },
  order_submitted: { label: 'Bestilt',   bg: '#d0edd1', color: '#1b5e20', border: '#81c784' },
}

// ─────────────────────────────────────────────────────────────────────────────
// Login form
// ─────────────────────────────────────────────────────────────────────────────

function LoginForm() {
  const [key, setKey] = useState('')
  return (
    <>
      <Head>
        <title>Login – CEPELO Admin</title>
        <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&display=swap" rel="stylesheet" />
      </Head>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:#F5F5F6;min-height:100vh;display:flex;align-items:center;justify-content:center}
        .box{background:#fff;border:1px solid #E0E0E4;border-radius:16px;padding:48px 40px;width:360px;text-align:center;box-shadow:0 4px 24px rgba(23,52,84,.06)}
        .logo{height:34px;margin-bottom:28px}
        h2{font-family:'Montserrat',sans-serif;font-size:20px;font-weight:800;color:#173454;margin-bottom:6px}
        p{font-size:13px;color:#767686;margin-bottom:28px}
        input{width:100%;padding:12px 16px;border:1.5px solid #E0E0E4;border-radius:8px;font-size:14px;font-family:inherit;outline:none;transition:border-color .15s;margin-bottom:14px}
        input:focus{border-color:#0868B2}
        button{width:100%;padding:13px;background:#0868B2;color:#fff;border:none;border-radius:27px;font-family:'Montserrat',sans-serif;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;cursor:pointer;transition:background .15s}
        button:hover{background:#173454}
      `}</style>
      <div className="box">
        <img src="/cepelo-logo.png" alt="CEPELO" className="logo" />
        <h2>Admin</h2>
        <p>Indtast adgangskode for at se tilbudsoversigten</p>
        <form method="GET" action="/admin/quotes">
          <input
            type="password"
            name="key"
            value={key}
            onChange={e => setKey(e.target.value)}
            placeholder="Adgangskode"
            autoFocus
          />
          <button type="submit">Vis tilbud →</button>
        </form>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Status badge
// ─────────────────────────────────────────────────────────────────────────────

function Badge({ status }) {
  const s = STATUS[status] || STATUS.draft
  return (
    <span style={{
      display: 'inline-block', padding: '3px 9px', borderRadius: 10,
      fontSize: 10, fontFamily: "'Montserrat',sans-serif",
      fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em',
      background: s.bg, color: s.color, border: `1px solid ${s.border}`,
      whiteSpace: 'nowrap',
    }}>{s.label}</span>
  )
}

function TypeBadge({ type }) {
  const isCustomer = type === 'customer'
  return (
    <span style={{
      display: 'inline-block', padding: '3px 9px', borderRadius: 10,
      fontSize: 10, fontFamily: "'Montserrat',sans-serif",
      fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em',
      background: isCustomer ? '#fff8e1' : '#f0f0f2',
      color:      isCustomer ? '#e65100' : '#767686',
      border:     `1px solid ${isCustomer ? '#ffcc80' : '#d4d4dc'}`,
      whiteSpace: 'nowrap',
    }}>{isCustomer ? 'Slutkunde' : 'Forhandler'}</span>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────────────────────

export default function QuotesDashboard({ quotes, authenticated, apiKey }) {
  if (!authenticated) return <LoginForm />

  // Aggregate stats
  const total         = quotes.length
  const sentCount     = quotes.filter(q => q.status !== 'draft').length
  const acceptedCount = quotes.filter(q => ['accepted', 'order_submitted'].includes(q.status)).length
  const pipelineGross = quotes
    .filter(q => q.status !== 'draft')
    .reduce((s, q) => s + calcTotals(q).gross, 0)

  const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || ''

  return (
    <>
      <Head>
        <title>Tilbudsoversigt – CEPELO</title>
        <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&display=swap" rel="stylesheet" />
      </Head>

      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        :root{
          --navy:#173454;--blue:#0868B2;--blue-light:#E8F3FC;
          --orange:#F19615;--paper:#F5F5F6;--card:#fff;
          --border:#E0E0E4;--ink:#323232;--muted:#767686;
          --green:#2e7d32;--red:#c62828;
        }
        body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:var(--paper);color:var(--ink);min-height:100vh}

        /* Page shell */
        .page{max-width:1320px;margin:0 auto;padding:32px 24px 80px}

        /* Header */
        .page-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:24px;border-bottom:1px solid var(--border);margin-bottom:28px;flex-wrap:wrap}
        .logo{height:32px}
        .header-right{text-align:right}
        .page-badge{display:inline-flex;align-items:center;gap:6px;font-family:'Montserrat',sans-serif;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;background:var(--navy);color:#fff;padding:4px 12px;border-radius:20px;margin-bottom:5px}
        .page-title{font-family:'Montserrat',sans-serif;font-size:22px;font-weight:800;color:var(--navy)}
        .page-count{font-size:12px;color:var(--muted);margin-top:2px}

        /* Stats row */
        .stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:28px}
        .stat-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px 22px}
        .stat-val{font-family:'Montserrat',sans-serif;font-size:26px;font-weight:800;color:var(--navy);line-height:1}
        .stat-label{font-family:'Montserrat',sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-top:6px}

        /* Table wrapper */
        .table-wrap{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden}
        .table-scroll{overflow-x:auto}
        table{width:100%;border-collapse:collapse;font-size:13px;white-space:nowrap}
        thead{background:var(--paper)}
        thead th{font-family:'Montserrat',sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);padding:12px 16px;text-align:left;border-bottom:1px solid var(--border)}
        thead th.num{text-align:right}
        tbody tr{border-bottom:1px solid var(--border);transition:background .1s;cursor:pointer}
        tbody tr:last-child{border-bottom:none}
        tbody tr:hover{background:var(--blue-light)}
        tbody td{padding:12px 16px;color:var(--ink);vertical-align:middle}
        tbody td.num{text-align:right;font-family:'Montserrat',sans-serif;font-weight:600;color:var(--navy)}
        tbody td.muted{color:var(--muted)}
        .ref-link{color:var(--blue);font-family:'Montserrat',sans-serif;font-size:12px;font-weight:700;text-decoration:none}
        .ref-link:hover{text-decoration:underline}
        .margin-good{color:var(--green)}
        .margin-warn{color:#e65100}

        /* empty state */
        .empty{padding:60px;text-align:center;color:var(--muted);font-size:14px}

        @media(max-width:900px){
          .stats-row{grid-template-columns:repeat(2,1fr)}
        }
        @media(max-width:560px){
          .stats-row{grid-template-columns:1fr 1fr}
          .page{padding:20px 14px 60px}
        }
      `}</style>

      <div className="page">

        {/* Header */}
        <div className="page-header">
          <img src="/cepelo-logo.png" alt="CEPELO" className="logo" />
          <div className="header-right">
            <div className="page-badge">⬤ Admin</div>
            <div className="page-title">Tilbudsoversigt</div>
            <div className="page-count">{total} tilbud</div>
          </div>
        </div>

        {/* Stats */}
        <div className="stats-row">
          <div className="stat-card">
            <div className="stat-val">{total}</div>
            <div className="stat-label">Tilbud i alt</div>
          </div>
          <div className="stat-card">
            <div className="stat-val">{sentCount}</div>
            <div className="stat-label">Sendt</div>
          </div>
          <div className="stat-card">
            <div className="stat-val">{acceptedCount}</div>
            <div className="stat-label">Accepteret / Bestilt</div>
          </div>
          <div className="stat-card">
            <div className="stat-val" style={{ fontSize: 18 }}>{fmtKr(pipelineGross)}</div>
            <div className="stat-label">Pipeline brutto</div>
          </div>
        </div>

        {/* Table */}
        <div className="table-wrap">
          <div className="table-scroll">
            {quotes.length === 0 ? (
              <div className="empty">Ingen tilbud endnu</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Dato</th>
                    <th>Ref</th>
                    <th>Forhandler</th>
                    <th>Sælger</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th className="num">Nettopris i alt</th>
                    <th className="num">Bruttopris i alt</th>
                    <th className="num">Avance %</th>
                  </tr>
                </thead>
                <tbody>
                  {quotes.map(q => {
                    const { net, gross, margin } = calcTotals(q)
                    const quoteUrl = `/quote/${q.token}`
                    const marginCls = margin === null ? '' : margin >= 25 ? 'margin-good' : 'margin-warn'
                    return (
                      <tr key={q.id} onClick={() => window.open(quoteUrl, '_blank')}>
                        <td className="muted">{fmtDate(q.created_at)}</td>
                        <td>
                          <a
                            className="ref-link"
                            href={quoteUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()}
                          >
                            {q.shopify_order_id || '—'}
                          </a>
                        </td>
                        <td>{q.dealer_name || <span className="muted">—</span>}</td>
                        <td className="muted">{q.sender_name || '—'}</td>
                        <td><TypeBadge type={q.type} /></td>
                        <td><Badge status={q.status} /></td>
                        <td className="num">{net > 0 ? fmtKr(net) : <span className="muted">—</span>}</td>
                        <td className="num">{gross > 0 ? fmtKr(gross) : <span className="muted">—</span>}</td>
                        <td className={`num ${marginCls}`}>
                          {margin !== null ? `${margin} %` : <span className="muted">—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Server-side: auth + data
// ─────────────────────────────────────────────────────────────────────────────

export async function getServerSideProps({ query }) {
  const key = (query.key || '').trim()

  // Reject if key is missing or wrong
  if (!key || key !== process.env.CEPELO_API_SECRET) {
    return { props: { authenticated: false, quotes: [], apiKey: '' } }
  }

  const { createClient } = await import('@supabase/supabase-js')
  const adminClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )

  const { data, error } = await adminClient
    .from('quotes')
    .select(
      'id, created_at, shopify_order_id, type, status, ' +
      'dealer_name, sender_name, token, customer_token, ' +
      'main_product, line_items'
    )
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) {
    console.error('[admin/quotes] Supabase error:', error.message)
    return { props: { authenticated: true, quotes: [], apiKey: key } }
  }

  return {
    props: {
      authenticated: true,
      apiKey: key,
      quotes: data || [],
    },
  }
}
