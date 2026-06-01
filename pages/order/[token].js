// pages/order/[token].js
//
// Dealer workshop / order details form.
// Accessed via the link sent to the dealer when a customer accepts their quote.
// Token = dealer token (quote.token).
//
// On submit: POSTs to /api/submit-order-form, then shows a success screen.

import { useState } from 'react'
import Head from 'next/head'

export default function OrderFormPage({ quote, notFound }) {
  const [submitted, setSubmitted]     = useState(false)
  const [loading,   setLoading]       = useState(false)
  const [error,     setError]         = useState(null)

  const [form, setForm] = useState({
    company_name:  quote?.dealer_name   || '',
    address:       '',
    cvr:           '',
    contact_name:  '',
    contact_email: quote?.dealer_email  || '',
    contact_phone: '',
    po_number:     '',
  })

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.company_name.trim()) { setError('Angiv venligst værkstedets navn.'); return }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/submit-order-form', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ dealer_token: quote.token, ...form }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      setSubmitted(true)
    } catch (err) {
      setError(err.message || 'Noget gik galt – prøv igen.')
    } finally {
      setLoading(false)
    }
  }

  const allProducts = [
    ...(quote?.main_product ? [quote.main_product] : []),
    ...(quote?.line_items   || []).filter(i => i.sku !== 'DELIVERY'),
  ]

  const shopifyRef = quote?.shopify_order_id && quote.shopify_order_id !== 'PARSED'
    ? quote.shopify_order_id : null

  return (
    <>
      <Head>
        <title>Ordreoplysninger – CEPELO</title>
        <meta name="robots" content="noindex" />
        <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&display=swap" rel="stylesheet" />
      </Head>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        :root{--navy:#173454;--blue:#0868B2;--blue-light:#E8F3FC;--border:#E0E0E4;--ink:#1a1a24;--ink-light:#323232;--ink-muted:#767686;--paper:#F5F5F6}
        body{font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;background:var(--paper);min-height:100vh;padding:32px 16px}
        .wrap{max-width:600px;margin:0 auto}
        .card{background:#fff;border-radius:12px;border:1px solid var(--border);overflow:hidden;margin-bottom:20px}
        .card-header{background:#fff;padding:20px 28px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
        .nav-bar{background:var(--navy);padding:10px 28px}
        .nav-bar span{color:rgba(255,255,255,.75);font-family:Montserrat,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:.1em;font-weight:600}
        .card-body{padding:28px}
        h1{font-family:Montserrat,sans-serif;font-size:20px;font-weight:800;color:var(--navy);margin-bottom:6px}
        .lead{font-size:14px;color:var(--ink-muted);line-height:1.7;margin-bottom:24px}
        .section-label{font-family:Montserrat,sans-serif;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--blue);font-weight:700;margin-bottom:14px}
        .field{margin-bottom:16px}
        label{display:block;font-family:Montserrat,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:.07em;font-weight:700;color:var(--ink-muted);margin-bottom:5px}
        input{width:100%;border:1.5px solid var(--border);border-radius:7px;padding:10px 14px;font-size:14px;color:var(--ink);outline:none;transition:border .15s;background:#fff}
        input:focus{border-color:var(--blue)}
        input::placeholder{color:#bbb}
        .optional{font-family:Montserrat,sans-serif;font-size:10px;color:var(--ink-muted);font-weight:400;letter-spacing:0;text-transform:none;margin-left:6px}
        .two-col{display:grid;grid-template-columns:1fr 1fr;gap:12px}
        .submit-btn{width:100%;background:var(--blue);color:#fff;font-family:Montserrat,sans-serif;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:14px;border-radius:28px;border:none;cursor:pointer;margin-top:8px;transition:opacity .15s}
        .submit-btn:hover{opacity:.88}
        .submit-btn:disabled{opacity:.6;cursor:wait}
        .error-box{background:#fef2f2;border:1px solid #fca5a5;border-radius:7px;padding:12px 16px;font-size:13px;color:#b91c1c;margin-bottom:16px}
        .order-summary{background:var(--paper);border-radius:8px;padding:16px 18px;margin-bottom:20px}
        .product-row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);font-size:14px;color:var(--ink-light)}
        .product-row:last-child{border-bottom:none}
        /* Success */
        .success-icon{width:64px;height:64px;border-radius:50%;background:var(--blue-light);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:28px;color:var(--blue)}
        .success-headline{font-family:Montserrat,sans-serif;font-size:22px;font-weight:800;color:var(--navy);text-align:center;margin-bottom:10px}
        .success-sub{font-size:14px;color:var(--ink-muted);line-height:1.7;text-align:center;max-width:380px;margin:0 auto}
        .footer{font-size:11px;color:var(--ink-muted);text-align:center;padding:8px 0 24px}
        @media(max-width:480px){.two-col{grid-template-columns:1fr}}
      `}</style>

      <div className="wrap">

        {/* Success screen */}
        {submitted ? (
          <div className="card">
            <div className="card-header">
              <img src="https://cepelo.dk/cdn/shop/files/Cepelo-blaa-uden-tools.webp" alt="CEPELO" width="110" style={{display:'block',height:'auto'}} />
            </div>
            <div className="nav-bar"><span>Ordrebekræftelse</span></div>
            <div className="card-body" style={{textAlign:'center',padding:'48px 28px'}}>
              <div className="success-icon">✓</div>
              <div className="success-headline">Oplysninger modtaget!</div>
              <div className="success-sub">
                Tak – vi har modtaget jeres ordreoplysninger og behandler ordren hurtigst muligt.
                En bekræftelse er sendt til CEPELO salgsteamet.
              </div>
            </div>
          </div>
        ) : notFound ? (
          <div className="card">
            <div className="card-header">
              <img src="https://cepelo.dk/cdn/shop/files/Cepelo-blaa-uden-tools.webp" alt="CEPELO" width="110" style={{display:'block',height:'auto'}} />
            </div>
            <div className="card-body" style={{padding:'40px 28px',textAlign:'center',color:'#767686'}}>
              Ordren blev ikke fundet eller linket er udløbet.
            </div>
          </div>
        ) : (
          <>
            {/* Order info card */}
            <div className="card">
              <div className="card-header">
                <img src="https://cepelo.dk/cdn/shop/files/Cepelo-blaa-uden-tools.webp" alt="CEPELO" width="110" style={{display:'block',height:'auto'}} />
                {shopifyRef && <span style={{fontFamily:'Montserrat,sans-serif',fontSize:12,color:'#767686',fontWeight:600}}>Ref. {shopifyRef}</span>}
              </div>
              <div className="nav-bar"><span>Ordrebekræftelse</span></div>
              <div className="card-body">
                <h1>Udfyld ordreoplysninger</h1>
                <p className="lead">
                  Kunden har accepteret tilbuddet. Udfyld venligst jeres værkstedsoplysninger nedenfor, så vi kan behandle ordren.
                </p>

                {allProducts.length > 0 && (
                  <>
                    <div className="section-label">Bestilte produkter</div>
                    <div className="order-summary">
                      {allProducts.map((p, i) => {
                        const name = typeof p.name === 'object' ? (p.name.da || p.sku) : (p.name || p.sku)
                        return (
                          <div key={i} className="product-row">
                            <span>{name}{p.quantity > 1 ? ` × ${p.quantity}` : ''}</span>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}

                {/* Form */}
                <form onSubmit={handleSubmit}>
                  <div className="section-label">Værkstedsoplysninger</div>

                  {error && <div className="error-box">{error}</div>}

                  <div className="field">
                    <label>Virksomhedsnavn</label>
                    <input value={form.company_name} onChange={set('company_name')} placeholder="Jeres værkstedsnavn" required />
                  </div>

                  <div className="field">
                    <label>Leveringsadresse</label>
                    <input value={form.address} onChange={set('address')} placeholder="Gade, postnr., by" />
                  </div>

                  <div className="field">
                    <label>CVR-nummer</label>
                    <input value={form.cvr} onChange={set('cvr')} placeholder="12345678" inputMode="numeric" />
                  </div>

                  <div className="section-label" style={{marginTop:8}}>Kontaktperson</div>

                  <div className="field">
                    <label>Navn</label>
                    <input value={form.contact_name} onChange={set('contact_name')} placeholder="Fulde navn" />
                  </div>

                  <div className="two-col">
                    <div className="field">
                      <label>E-mail</label>
                      <input type="email" value={form.contact_email} onChange={set('contact_email')} placeholder="navn@firma.dk" />
                    </div>
                    <div className="field">
                      <label>Telefon</label>
                      <input type="tel" value={form.contact_phone} onChange={set('contact_phone')} placeholder="+45 00 00 00 00" />
                    </div>
                  </div>

                  <div className="section-label" style={{marginTop:8}}>Ordre</div>

                  <div className="field">
                    <label>PO-nummer <span className="optional">valgfrit</span></label>
                    <input value={form.po_number} onChange={set('po_number')} placeholder="Jeres interne PO / ordrenummer" />
                  </div>

                  <button type="submit" className="submit-btn" disabled={loading}>
                    {loading ? 'Sender…' : 'Send ordrebekræftelse →'}
                  </button>
                </form>
              </div>
            </div>
          </>
        )}

        <div className="footer">CEPELO A/S · Nibevej 54, 9200 Aalborg SV · +45 98 18 09 00 · info@cepelo.dk</div>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Server-side data fetching
// ─────────────────────────────────────────────────────────────────────────────

export async function getServerSideProps({ params }) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  const { createClient } = await import('@supabase/supabase-js')
  const adminClient = createClient(url, key)

  const { data: quote, error } = await adminClient
    .from('quotes')
    .select('token, shopify_order_id, dealer_name, dealer_email, dealer_phone, main_product, line_items, status')
    .eq('token', params.token)
    .single()

  if (error || !quote) {
    return { props: { quote: null, notFound: true } }
  }

  return { props: { quote, notFound: false } }
}
