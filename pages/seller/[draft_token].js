// pages/seller/[draft_token].js
//
// Internal CEPELO seller form — appears between receiving the Shopify email
// and sending the quote to the dealer.
//
// Flow:
//   parse-email → creates draft quote → emails CEPELO seller
//   CEPELO seller opens /seller/[draft_token] → fills in form → submits
//   submit-seller-form → updates quote to 'sent' → emails dealer

import { useState } from 'react'
import Head from 'next/head'
import { formatPrice } from '../../lib/format'

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function SectionCard({ title, children }) {
  return (
    <div className="section-card">
      <div className="section-heading">{title}</div>
      {children}
    </div>
  )
}

function Field({ label, required, children }) {
  return (
    <div className="field">
      <label className="field-label">{label}{required && <span className="req"> *</span>}</label>
      {children}
    </div>
  )
}

function Input({ value, onChange, placeholder, type = 'text', disabled }) {
  return (
    <input
      className="field-input"
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder || ''}
      disabled={disabled}
      autoComplete="off"
    />
  )
}

function Textarea({ value, onChange, placeholder, rows = 3 }) {
  return (
    <textarea
      className="field-textarea"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder || ''}
      rows={rows}
    />
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Product summary strip (read-only, shown for context)
// ─────────────────────────────────────────────────────────────────────────────

function ProductStrip({ mainProduct, lineItems }) {
  const allItems = lineItems || []

  // Regular products: SKU-based items, not special types
  const products = [mainProduct, ...allItems.filter(i =>
    i && !['manual', 'discount'].includes(i.type) && i.sku !== 'DELIVERY'
  )].filter(Boolean)

  // Extra lines: fragt, montering, levering, rabat
  const extras = allItems.filter(i =>
    i.type === 'manual' || i.sku === 'DELIVERY' || i.type === 'discount'
  )

  if (!products.length && !extras.length) return null

  return (
    <div className="product-strip">
      <div className="strip-label">Produkter i tilbuddet</div>
      <div className="strip-list">
        {products.map((p, i) => (
          <div className="strip-item" key={i}>
            {p.image_url
              ? <img src={p.image_url} alt={p.name} className="strip-img" />
              : <div className="strip-img strip-img-placeholder">⚙</div>}
            <div className="strip-info">
              <div className="strip-name">{p.name || p.sku}</div>
              <div className="strip-meta">
                {p.sku && <span className="strip-sku">{p.sku}</span>}
                {p.quantity > 1 && <span className="strip-qty">× {p.quantity}</span>}
                {p.net_price > 0 && <span className="strip-price">Netto: {formatPrice(p.net_price, 'da')}</span>}
                {p.gross_price > 0 && <span className="strip-gross">Brutto: {formatPrice(p.gross_price, 'da')}</span>}
              </div>
            </div>
          </div>
        ))}

        {extras.length > 0 && (
          <div className="strip-extras">
            {extras.map((item, i) => {
              const isDiscount = item.type === 'discount'
              const amount     = isDiscount
                ? `−${formatPrice(Math.abs(item.net_price || 0), 'da')}`
                : formatPrice(item.gross_price || item.net_price || 0, 'da')
              const label = isDiscount
                ? `Rabat${item.name && item.name !== 'Besparelse' ? ` (${item.name})` : ''}`
                : item.name
              return (
                <div key={i} className={`strip-extra-row${isDiscount ? ' is-discount' : ''}`}>
                  <span className="extra-label">{label}</span>
                  <span className={`extra-amount${isDiscount ? ' is-discount' : ''}`}>{amount}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Success screen
// ─────────────────────────────────────────────────────────────────────────────

function SuccessScreen({ result, dealerEmail }) {
  return (
    <div className="success-wrap">
      <div className="success-icon">✓</div>
      <h2 className="success-title">Tilbud sendt til forhandler</h2>
      <p className="success-sub">Tilbuddet er nu sendt til <strong>{dealerEmail}</strong>.</p>
      <div className="success-links">
        <a href={result.dealer_url} className="success-link-btn" target="_blank" rel="noopener noreferrer">
          Åbn forhandlervisning →
        </a>
        <a href={result.customer_url} className="success-link-secondary" target="_blank" rel="noopener noreferrer">
          Åbn slutkundevisning
        </a>
      </div>
      <div className="success-urls">
        <div className="url-row"><span className="url-label">Forhandler-link</span><span className="url-val">{result.dealer_url}</span></div>
        <div className="url-row"><span className="url-label">Slutkunde-link</span><span className="url-val">{result.customer_url}</span></div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────

export default function SellerFormPage({ quote, draft_token, prefill }) {
  // ── Form state ────────────────────────────────────────────────────────────
  const [dealerName,    setDealerName]    = useState(prefill?.dealer_name || '')
  const [dealerDept,    setDealerDept]    = useState('')
  const [dealerEmail,   setDealerEmail]   = useState('')

  const [custCompany, setCustCompany] = useState('')
  const [custContact, setCustContact] = useState('')
  const [custEmail,   setCustEmail]   = useState('')
  const [custPhone,   setCustPhone]   = useState('')
  const [custAddress, setCustAddress] = useState('')

  const [quoteType,   setQuoteType]   = useState('dealer')
  const [agreedPrice, setAgreedPrice] = useState('')
  const [notes,       setNotes]       = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [submitted,  setSubmitted]  = useState(null)
  const [error,      setError]      = useState(null)

  // ── Not found ─────────────────────────────────────────────────────────────
  if (!quote) {
    return (
      <div style={{ fontFamily: 'sans-serif', padding: 60, textAlign: 'center', color: '#173454' }}>
        <h2>Tilbud ikke fundet</h2>
        <p style={{ color: '#767686', marginTop: 8 }}>draft_token matcher ikke et eksisterende tilbud.</p>
      </div>
    )
  }

  // ── Already submitted ─────────────────────────────────────────────────────
  if (quote.status !== 'draft') {
    return (
      <>
        <Head><title>Tilbud allerede sendt – CEPELO</title></Head>
        <div style={{ fontFamily: 'sans-serif', padding: 60, textAlign: 'center', color: '#173454' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>✓</div>
          <h2>Tilbuddet er allerede sendt</h2>
          <p style={{ color: '#767686', marginTop: 8 }}>Dette tilbud er allerede behandlet og sendt.</p>
          {quote.token && (
            <a href={`/quote/${quote.token}`} style={{ color: '#0868B2', marginTop: 16, display: 'inline-block' }}>
              Se tilbuddet →
            </a>
          )}
        </div>
      </>
    )
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!dealerEmail.trim()) { setError('Email til forhandler er påkrævet'); return }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/submit-seller-form', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          draft_token,
          dealer_name:       dealerName,
          dealer_dept:       dealerDept,
          dealer_email:      dealerEmail,
          recipient_company: custCompany,
          recipient_name:    custContact,
          recipient_email:   custEmail,
          recipient_phone:   custPhone,
          recipient_address: custAddress,
          type:              quoteType,
          agreed_price:      agreedPrice,
          notes,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Ukendt fejl')
      setSubmitted(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const quoteRef = quote.shopify_order_id && quote.shopify_order_id !== 'PARSED'
    ? quote.shopify_order_id : null

  return (
    <>
      <Head>
        <title>Udfyld tilbud{quoteRef ? ` ${quoteRef}` : ''} – CEPELO</title>
        <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&display=swap" rel="stylesheet" />
      </Head>

      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        :root{--navy:#173454;--blue:#0868B2;--blue-light:#E8F3FC;--orange:#F19615;--paper:#F5F5F6;--card:#fff;--border:#E0E0E4;--ink:#323232;--muted:#767686;--green:#2e7d32;--red:#c62828}
        body{font-family:-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background:var(--paper);color:var(--ink);min-height:100vh}
        .page{max-width:720px;margin:0 auto;padding:40px 24px 80px}

        /* Header */
        .page-header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding-bottom:28px;border-bottom:1px solid var(--border);margin-bottom:32px}
        .header-left img{height:36px;display:block}
        .header-left .tagline{font-family:'Montserrat',sans-serif;font-size:10px;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;font-weight:600;margin-top:4px}
        .header-right{text-align:right}
        .page-badge{display:inline-flex;align-items:center;gap:6px;font-family:'Montserrat',sans-serif;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;background:var(--navy);color:#fff;padding:4px 12px;border-radius:20px;margin-bottom:6px}
        .page-title{font-family:'Montserrat',sans-serif;font-size:22px;font-weight:800;color:var(--navy);line-height:1.2}
        .page-ref{font-size:13px;color:var(--muted);margin-top:3px}

        /* Product strip */
        .product-strip{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px 24px;margin-bottom:28px}
        .strip-label{font-family:'Montserrat',sans-serif;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:14px}
        .strip-list{display:flex;flex-direction:column;gap:10px}
        .strip-item{display:flex;align-items:center;gap:14px}
        .strip-img{width:44px;height:44px;object-fit:cover;border-radius:6px;background:var(--paper);flex-shrink:0}
        .strip-img-placeholder{display:flex;align-items:center;justify-content:center;font-size:18px;color:var(--muted)}
        .strip-name{font-size:14px;font-weight:600;color:var(--navy);line-height:1.3}
        .strip-meta{display:flex;gap:10px;margin-top:3px;flex-wrap:wrap}
        .strip-sku{font-size:11px;color:var(--muted);background:var(--paper);padding:1px 6px;border-radius:4px}
        .strip-qty{font-size:11px;color:var(--muted)}
        .strip-price{font-family:'Montserrat',sans-serif;font-size:12px;font-weight:600;color:var(--navy)}
        .strip-gross{font-family:'Montserrat',sans-serif;font-size:12px;font-weight:600;color:var(--muted)}
        .strip-extras{border-top:1px solid var(--border);margin-top:10px;padding-top:10px;display:flex;flex-direction:column;gap:4px}
        .strip-extra-row{display:flex;justify-content:space-between;align-items:center;padding:2px 0}
        .strip-extra-row.is-discount{}
        .extra-label{font-size:13px;color:var(--ink)}
        .extra-amount{font-family:'Montserrat',sans-serif;font-size:12px;font-weight:600;color:var(--navy)}
        .extra-amount.is-discount{color:var(--green)}

        /* Form sections */
        .form-sections{display:flex;flex-direction:column;gap:20px;margin-bottom:28px}
        .section-card{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden}
        .section-heading{font-family:'Montserrat',sans-serif;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);padding:16px 24px;border-bottom:1px solid var(--border);background:var(--paper)}
        .fields-grid{display:grid;grid-template-columns:1fr 1fr;gap:0}
        .field{padding:14px 24px;border-bottom:1px solid var(--border)}
        .field:last-child,.field:nth-last-child(2):nth-child(odd){border-bottom:none}
        .field:nth-child(odd){border-right:1px solid var(--border)}
        .field-full{grid-column:1/-1}
        .field-full:last-child{border-bottom:none}
        .field-label{font-family:'Montserrat',sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);display:block;margin-bottom:6px}
        .req{color:var(--orange)}
        .field-input{width:100%;border:none;outline:none;font-size:14px;color:var(--navy);background:transparent;padding:0;font-family:inherit;font-weight:600}
        .field-input:disabled{color:var(--muted);cursor:default}
        .field-input::placeholder{color:#bbbbc8;font-weight:400}
        .field-textarea{width:100%;border:none;outline:none;font-size:14px;color:var(--navy);background:transparent;padding:0;font-family:inherit;resize:vertical;line-height:1.6}
        .field-textarea::placeholder{color:#bbbbc8}

        /* Radio group */
        .radio-group{display:flex;gap:12px;padding:4px 0}
        .radio-option{display:flex;align-items:center;gap:8px;cursor:pointer;padding:8px 16px;border:2px solid var(--border);border-radius:27px;transition:all .15s;font-family:'Montserrat',sans-serif;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);user-select:none}
        .radio-option.active{border-color:var(--blue);background:var(--blue-light);color:var(--navy)}
        .radio-dot{width:14px;height:14px;border-radius:50%;border:2px solid currentColor;display:flex;align-items:center;justify-content:center;flex-shrink:0}
        .radio-dot::after{content:'';width:6px;height:6px;border-radius:50%;background:currentColor;display:none}
        .radio-option.active .radio-dot::after{display:block}

        /* Submit area */
        .submit-area{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px}
        .error-msg{background:#fdecea;border:1px solid #f5c6c2;border-radius:8px;color:var(--red);font-size:13px;padding:10px 16px;margin-bottom:16px}
        .submit-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;font-family:'Montserrat',sans-serif;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:16px 32px;background:var(--blue);color:#fff;border:none;border-radius:27px;cursor:pointer;transition:background .15s}
        .submit-btn:hover:not(:disabled){background:var(--navy)}
        .submit-btn:disabled{opacity:.6;cursor:not-allowed}
        .submit-note{font-size:12px;color:var(--muted);text-align:center;margin-top:12px}

        /* Success */
        .success-wrap{text-align:center;padding:60px 32px}
        .success-icon{width:64px;height:64px;border-radius:50%;background:var(--navy);color:#fff;font-size:28px;display:flex;align-items:center;justify-content:center;margin:0 auto 20px}
        .success-title{font-family:'Montserrat',sans-serif;font-size:24px;font-weight:800;color:var(--navy);margin-bottom:8px}
        .success-sub{font-size:15px;color:var(--ink);margin-bottom:28px}
        .success-links{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-bottom:28px}
        .success-link-btn{font-family:'Montserrat',sans-serif;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:13px 28px;background:var(--blue);color:#fff;border-radius:27px;text-decoration:none;transition:background .15s}
        .success-link-btn:hover{background:var(--navy)}
        .success-link-secondary{font-family:'Montserrat',sans-serif;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:12px 24px;background:var(--paper);color:var(--blue);border:1px solid var(--border);border-radius:27px;text-decoration:none}
        .success-urls{background:var(--paper);border-radius:10px;padding:16px 20px;text-align:left;max-width:500px;margin:0 auto}
        .url-row{display:flex;flex-direction:column;gap:2px;padding:8px 0;border-bottom:1px solid var(--border)}
        .url-row:last-child{border-bottom:none}
        .url-label{font-family:'Montserrat',sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
        .url-val{font-size:12px;color:var(--blue);word-break:break-all}

        @media(max-width:560px){.fields-grid{grid-template-columns:1fr}.field:nth-child(odd){border-right:none}.field{border-bottom:1px solid var(--border)}.field:last-child{border-bottom:none}.page-header{flex-direction:column;gap:12px}.header-right{text-align:left}}
      `}</style>

      <div className="page">

        {/* Header */}
        <div className="page-header">
          <div className="header-left">
            <img src="/cepelo-logo.png" alt="CEPELO" />
            <div className="tagline">Vi sikrer fremtidens værksted</div>
          </div>
          <div className="header-right">
            <div className="page-badge">⬤ Intern sælgerformular</div>
            <div className="page-title">Udfyld og send tilbud</div>
            {quoteRef && <div className="page-ref">Ordrenr. {quoteRef}</div>}
          </div>
        </div>

        {/* Product context strip */}
        <ProductStrip mainProduct={quote.main_product} lineItems={quote.line_items} />

        {submitted ? (
          <SuccessScreen result={submitted} dealerEmail={dealerEmail} />
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="form-sections">

              {/* ── Section 1: Forhandler ── */}
              <SectionCard title="Forhandler">
                <div className="fields-grid">
                  <Field label="Navn">
                    <Input value={dealerName} onChange={setDealerName} placeholder="Forhandlernavn" />
                  </Field>
                  <Field label="Afdeling">
                    <Input value={dealerDept} onChange={setDealerDept} placeholder="Afdeling / att." />
                  </Field>
                  <Field label="Email tilbuddet sendes til" required>
                    <Input value={dealerEmail} onChange={setDealerEmail} placeholder="forhandler@firma.dk" type="email" />
                  </Field>
                </div>
              </SectionCard>

              {/* ── Section 2: Slutkunde ── */}
              <SectionCard title="Slutkunde">
                <div className="fields-grid">
                  <Field label="Virksomhedsnavn">
                    <Input value={custCompany} onChange={setCustCompany} placeholder="Kundens firma" />
                  </Field>
                  <Field label="Kontaktperson">
                    <Input value={custContact} onChange={setCustContact} placeholder="Fulde navn" />
                  </Field>
                  <Field label="Email">
                    <Input value={custEmail} onChange={setCustEmail} placeholder="kontakt@kunde.dk" type="email" />
                  </Field>
                  <Field label="Telefon">
                    <Input value={custPhone} onChange={setCustPhone} placeholder="+45 xx xx xx xx" type="tel" />
                  </Field>
                  <Field label="Adresse" required={false}>
                    <Input value={custAddress} onChange={setCustAddress} placeholder="Gadenavn, by" />
                  </Field>
                </div>
              </SectionCard>

              {/* ── Section 3: Tilbud ── */}
              <SectionCard title="Tilbud">
                <div className="fields-grid">
                  <Field label="Send tilbud som">
                    <div className="radio-group">
                      {[
                        { value: 'dealer',   label: 'Forhandler' },
                        { value: 'customer', label: 'Slutkunde'  },
                      ].map(opt => (
                        <div
                          key={opt.value}
                          className={`radio-option${quoteType === opt.value ? ' active' : ''}`}
                          onClick={() => setQuoteType(opt.value)}
                        >
                          <span className="radio-dot" />
                          {opt.label}
                        </div>
                      ))}
                    </div>
                  </Field>
                  <Field label="Aftalt pris til slutkunde (valgfri)">
                    <Input value={agreedPrice} onChange={setAgreedPrice} placeholder="F.eks. 44.995 kr" />
                  </Field>
                  <Field label="Besked til forhandler (valgfri)" required={false}>
                    <div className="field-full">
                      <Textarea
                        value={notes}
                        onChange={setNotes}
                        placeholder="Intern note eller besked til forhandleren der vises i tilbuddet…"
                        rows={3}
                      />
                    </div>
                  </Field>
                </div>
              </SectionCard>

            </div>{/* /form-sections */}

            {/* Submit */}
            <div className="submit-area">
              {error && <div className="error-msg">⚠ {error}</div>}
              <button type="submit" className="submit-btn" disabled={submitting}>
                {submitting ? 'Sender…' : 'Send tilbud til forhandler →'}
              </button>
              <div className="submit-note">
                {quoteType === 'dealer'
                  ? 'Forhandleren modtager et link med nettopriser og redigerbare bruttopriser.'
                  : 'Slutkunden modtager direkte et kundetilbud med bruttopriser.'}
              </div>
            </div>

          </form>
        )}
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
    .select('*')
    .eq('draft_token', params.draft_token)
    .single()

  if (error || !quote) return { props: { quote: null, draft_token: params.draft_token, prefill: {} } }

  return {
    props: {
      draft_token: params.draft_token,
      quote: {
        status:           quote.status,
        shopify_order_id: quote.shopify_order_id,
        token:            quote.token,
        main_product:     quote.main_product  || null,
        line_items:       quote.line_items    || [],
        dealer_name:      quote.dealer_name   || '',
        lang:             quote.lang          || 'da',
      },
      prefill: {
        dealer_name: quote.dealer_name || '',
      },
    },
  }
}
