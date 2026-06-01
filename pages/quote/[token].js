import { useState, useEffect } from 'react'
import Head from 'next/head'
import { supabase } from '../../lib/supabase'
import { getT } from '../../lib/translations'
import { formatPrice, addVat, calcVat, parsePrice } from '../../lib/format'
import { calcLeasing } from '../../lib/leasing'
import { getDealerInfo } from '../../lib/dealers'

// ─────────────────────────────────────────────────────────────────────────────

export default function QuotePage({ quote }) {
  const lang     = quote?.lang || 'da'
  const tr       = getT(lang)
  const isDealer = quote?.type === 'dealer'

  // Initialise editable price fields as formatted strings so they display
  // nicely. parsePrice() in the totals block handles the formatted string.
  const [mainGross, setMainGross] = useState(formatPrice(quote?.main_product?.gross_price || 0, lang))
  const [lineGross, setLineGross] = useState((quote?.line_items || []).map(i =>
    formatPrice((i.gross_price || 0) * (i.quantity || 1), lang)
  ))
  const [selectedAccessories, setSelectedAccessories] = useState([])
  // Dealer editable note — local state only, used in mailto (issue #13)
  const [dealerNote, setDealerNote] = useState('')
  // Acceptance flow
  const [accepted,       setAccepted]       = useState(false)
  const [acceptLoading,  setAcceptLoading]  = useState(false)

  useEffect(() => {
    // Dealer view: match by token; Customer view: match by customer_token
    const col = quote?.token ? 'token' : 'customer_token'
    const key = quote?.token || quote?.customer_token
    if (!key) return
    supabase.from('quotes').update({ opened_at: new Date().toISOString() }).eq(col, key).then(() => {})
  }, [quote?.token, quote?.customer_token])

  if (!quote) return (
    <div style={{ fontFamily: 'sans-serif', padding: 40, textAlign: 'center', color: '#333' }}>
      <p>Tilbud ikke fundet eller udløbet.</p>
    </div>
  )

  const accessories     = quote.available_accessories || []
  // Product line items: regular products (no typed sub-items, no manual lines)
  const productLineItems = (quote.line_items || []).filter(i =>
    !['accessory', 'software', 'subscription', 'manual'].includes(i.type)
  )
  const manualLineItems  = (quote.line_items || []).filter(i => i.type === 'manual')
  // Typed sub-items shown inside the main product block
  const hardware         = (quote.line_items || []).filter(i => i.type === 'accessory')
  const software         = (quote.line_items || []).filter(i => i.type === 'software')
  const subscriptions    = (quote.line_items || []).filter(i => i.type === 'subscription')

  // Combined product list, sorted by gross_price descending (issue #9)
  const allProductItems = [
    ...(quote.main_product
      ? [{ ...quote.main_product, _isMain: true,  _liIdx: -1 }]
      : []),
    ...productLineItems.map(item => ({
      ...item,
      _isMain: false,
      _liIdx:  (quote.line_items || []).indexOf(item),
    })),
  ].sort((a, b) => (b.gross_price || 0) - (a.gross_price || 0))

  // Truncate description to first 2 sentences
  function shortDesc(text) {
    if (!text) return ''
    let count = 0
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '.' || text[i] === '!' || text[i] === '?') {
        if (++count === 2) return text.slice(0, i + 1).trim()
      }
    }
    return text.length > 250 ? text.slice(0, 250) + '…' : text
  }

  const selectedTotal       = selectedAccessories.reduce((sum, acc) => sum + (parsePrice(acc.gross_price) || 0), 0)

  // Base gross (main product + non-subscription line items, editable by dealer)
  const baseGrossTotal      = parsePrice(mainGross) +
    lineGross.filter((_, idx) => (quote.line_items || [])[idx]?.type !== 'subscription')
             .reduce((a, v) => a + parsePrice(v), 0)

  // Total gross including any optionally selected accessories
  const totalGrossOneTime   = baseGrossTotal + selectedTotal

  // Netto total — main product + non-subscription line items only (accessories excluded)
  const totalNetOneTime     = (quote.main_product?.net_price || 0) +
    (quote.line_items || [])
      .filter(i => i.type !== 'subscription')
      .reduce((sum, i) => sum + ((i.net_price || 0) * (i.quantity || 1)), 0)

  // Avance = total dealer gross (incl. selected accessories) minus total net
  const avanceAmount        = totalGrossOneTime - totalNetOneTime
  const avancePct           = totalNetOneTime > 0
    ? Math.round((avanceAmount / totalNetOneTime) * 100)
    : 0

  const leasing = calcLeasing(totalGrossOneTime)

  const dateStr = (iso) => {
    if (!iso) return ''
    return new Date(iso).toLocaleDateString(
      lang === 'is' ? 'is-IS' : lang === 'no' ? 'nb-NO' : 'da-DK',
      { day: 'numeric', month: 'long', year: 'numeric' }
    )
  }

  const toggleAccessory = (acc) => {
    setSelectedAccessories(prev =>
      prev.find(a => a.sku === acc.sku) ? prev.filter(a => a.sku !== acc.sku) : [...prev, acc]
    )
  }

  const handleAccept = async () => {
    if (acceptLoading) return
    setAcceptLoading(true)
    try {
      const res = await fetch('/api/accept-quote', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          customer_token:       quote.customer_token,
          selected_accessories: selectedAccessories,
          // Dealer-edited final prices (numeric, excl. VAT)
          main_gross:  parsePrice(mainGross),
          line_gross:  lineGross.map(v => parsePrice(v)),
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setAccepted(true)
    } catch (e) {
      console.error('[accept] failed:', e)
      alert('Noget gik galt – prøv igen eller kontakt CEPELO direkte.')
    } finally {
      setAcceptLoading(false)
    }
  }

  // Is this an Autodiagnose quote? Used for software update section (issue #11)
  const isAutodiagnose = quote.category === 'Autodiagnose' ||
    (quote.main_product?.product_type || '').toLowerCase().includes('diagnos')

  // Dealer branding — available in both dealer and customer views
  const dealerInfo    = getDealerInfo(quote.dealer_email)
  const dealerLogoUrl = dealerInfo?.logoUrl || null

  // Shopify ref for display (hide placeholder value 'PARSED')
  const shopifyRef = quote.shopify_order_id && quote.shopify_order_id !== 'PARSED'
    ? quote.shopify_order_id : null

  // ── Confirmation page (shown after customer accepts) ────────────────────────
  if (accepted) {
    // Build confirmed product list with dealer-edited prices
    // lineGross stores formatted totals (price × qty already); parsePrice gives the number
    const confirmedMain = quote.main_product
      ? [{ ...quote.main_product, _total: parsePrice(mainGross) }]
      : []

    const confirmedLines = (quote.line_items || []).map((item, idx) => ({
      ...item,
      _total: parsePrice(lineGross[idx] ?? formatPrice((item.gross_price || 0) * (item.quantity || 1), lang)),
    }))

    const confirmedAccs = selectedAccessories.map(acc => ({
      ...acc,
      _total: (parsePrice(acc.gross_price) || 0) * (acc.quantity || 1),
    }))

    const allConfirmed = [...confirmedMain, ...confirmedLines, ...confirmedAccs]
    const grossTotal   = allConfirmed.reduce((s, p) => s + (p._total || 0), 0)
    const vatAmt       = Math.round(grossTotal * 0.25)
    const inclVat      = grossTotal + vatAmt

    return (
      <>
        <Head>
          <title>Ordre bekræftet – CEPELO</title>
          <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&display=swap" rel="stylesheet" />
        </Head>
        <style>{`
          *{box-sizing:border-box;margin:0;padding:0}
          body{font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;background:#F5F5F6;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px}
          .conf-card{background:#fff;border-radius:16px;border:1px solid #E0E0E4;max-width:560px;width:100%;overflow:hidden}
          .conf-header{background:#fff;padding:20px 32px;border-bottom:1px solid #E0E0E4;display:flex;align-items:center;justify-content:space-between}
          .conf-bar{background:#173454;padding:10px 32px}
          .conf-bar span{color:rgba(255,255,255,.75);font-family:Montserrat,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:.1em;font-weight:600}
          .conf-body{padding:40px 32px}
          .conf-check{width:64px;height:64px;border-radius:50%;background:#E8F3FC;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:30px;color:#0868B2}
          .conf-headline{font-family:Montserrat,sans-serif;font-size:24px;font-weight:800;color:#173454;text-align:center;margin-bottom:12px}
          .conf-sub{font-size:14px;color:#767686;line-height:1.7;text-align:center;max-width:400px;margin:0 auto 32px}
          .conf-divider{height:1px;background:#E0E0E4;margin:28px 0}
          .conf-section-label{font-family:Montserrat,sans-serif;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#0868B2;font-weight:700;margin-bottom:14px}
          .conf-product{display:flex;justify-content:space-between;align-items:baseline;padding:8px 0;border-bottom:1px solid #F0F0F2;font-size:14px;color:#323232}
          .conf-product:last-child{border-bottom:none}
          .conf-product-name{font-weight:600;color:#173454}
          .conf-product-price{color:#767686;white-space:nowrap;margin-left:12px}
          .conf-total-row{display:flex;justify-content:space-between;align-items:baseline;padding:6px 0;font-size:14px;color:#767686}
          .conf-total-row.main{font-family:Montserrat,sans-serif;font-size:17px;font-weight:800;color:#173454;padding-top:12px}
          .conf-contact{background:#F5F5F6;border-radius:10px;padding:16px 20px;font-size:13px;color:#323232;line-height:1.8}
          .conf-footer{padding:16px 32px;border-top:1px solid #E0E0E4;font-size:11px;color:#767686;text-align:center}
        `}</style>
        <div className="conf-card">
          {/* Header */}
          <div className="conf-header">
            <img src="https://cepelo.dk/cdn/shop/files/Cepelo-blaa-uden-tools.webp" alt="CEPELO" width="120" style={{display:'block',height:'auto'}} />
            {dealerLogoUrl && <img src={dealerLogoUrl} alt="" style={{display:'block',height:28,maxWidth:100,objectFit:'contain'}} />}
          </div>
          <div className="conf-bar"><span>Vi sikrer fremtidens værksted</span></div>

          {/* Body */}
          <div className="conf-body">
            <div className="conf-check">✓</div>
            <div className="conf-headline">Tak for din ordre! 🎉</div>
            <div className="conf-sub">
              Vi glæder os til at levere dit nye udstyr.<br />
              Du vil snart blive kontaktet vedrørende levering og installation.
            </div>

            {/* Product summary */}
            {allConfirmed.length > 0 && (
              <>
                <div className="conf-section-label">Bestilte produkter</div>
                <div style={{marginBottom:20}}>
                  {allConfirmed.map((p, i) => {
                    const name = typeof p.name === 'object' ? (p.name[lang] || p.name.da || p.sku) : (p.name || p.sku)
                    return (
                      <div key={i} className="conf-product">
                        <span className="conf-product-name">
                          {name}{(p.quantity || 1) > 1 ? <span style={{fontWeight:400,color:'#767686'}}> × {p.quantity}</span> : null}
                        </span>
                        {(p._total || 0) > 0 && <span className="conf-product-price">{Math.round(p._total).toLocaleString('da-DK')} kr</span>}
                      </div>
                    )
                  })}
                </div>

                {/* Totals */}
                <div style={{borderTop:'2px solid #E0E0E4',paddingTop:12}}>
                  <div className="conf-total-row">
                    <span>Subtotal ekskl. moms</span>
                    <span>{grossTotal.toLocaleString('da-DK')} kr</span>
                  </div>
                  <div className="conf-total-row">
                    <span>Moms (25%)</span>
                    <span>{vatAmt.toLocaleString('da-DK')} kr</span>
                  </div>
                  <div className="conf-total-row main">
                    <span>Total inkl. moms</span>
                    <span>{inclVat.toLocaleString('da-DK')} kr</span>
                  </div>
                </div>
              </>
            )}

            <div className="conf-divider" />

            {/* CEPELO contact */}
            <div className="conf-section-label">CEPELO kontakt</div>
            <div className="conf-contact">
              <strong>CEPELO A/S</strong><br />
              Nibevej 54, 9200 Aalborg SV<br />
              +45 98 18 09 00<br />
              <a href="mailto:info@cepelo.dk" style={{color:'#0868B2',textDecoration:'none'}}>info@cepelo.dk</a>
              {' · '}
              <a href="https://cepelo.dk" style={{color:'#0868B2',textDecoration:'none'}}>cepelo.dk</a>
            </div>
          </div>

          <div className="conf-footer">CEPELO A/S · Nibevej 54, 9200 Aalborg SV · +45 98 18 09 00</div>
        </div>
      </>
    )
  }

  return (
    <>
      <Head>
        <title>{tr.quote} #{(quote.token || quote.customer_token)?.slice(-6).toUpperCase()}</title>
        <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&display=swap" rel="stylesheet" />
      </Head>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        :root{--ink:#1a1a24;--ink-light:#323232;--ink-muted:#767686;--paper:#F5F5F6;--paper-warm:#ECEDF0;--blue:#0868B2;--blue-light:#E8F3FC;--navy:#173454;--dealer-bg:#173454;--border:#E0E0E4;--white:#fff;--card-bg:#F7F7F7;--green:#2e7d32;--green-bg:#e8f5e9;--orange:#F19615;--orange-bg:#FFF3E0}
        body{font-family:-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background:var(--paper);color:var(--ink-light)}
        .page{max-width:860px;margin:0 auto;padding:48px 32px 80px}
        .view-badge{display:inline-flex;align-items:center;gap:6px;font-family:'Montserrat',sans-serif;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;padding:5px 14px;border-radius:20px;margin-bottom:28px}
        .view-badge.dealer{background:var(--navy);color:#fff}
        .view-badge.customer{background:var(--paper);color:var(--navy);border:1px solid var(--border)}
        .dot{width:6px;height:6px;border-radius:50%}
        .dealer .dot{background:#fff} .customer .dot{background:var(--blue)}
        .quote-header{display:grid;grid-template-columns:1fr auto;align-items:start;gap:32px;padding-bottom:36px;border-bottom:1px solid var(--border);margin-bottom:40px}
        .tagline{font-family:'Montserrat',sans-serif;font-size:11px;color:var(--ink-muted);letter-spacing:.1em;text-transform:uppercase;font-weight:600;margin-top:4px}
        .header-dealer{font-size:12px;color:var(--ink-light);margin-top:8px;padding-top:8px;border-top:1px solid var(--border)}
        .quote-meta{text-align:right}
        .quote-label{font-family:'Montserrat',sans-serif;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-muted);font-weight:600;margin-bottom:6px}
        .quote-number{font-family:'Montserrat',sans-serif;font-size:22px;font-weight:800;color:var(--navy)}
        .quote-shopify-ref{font-size:12px;color:var(--ink-muted);margin-top:3px}
        .quote-date{font-size:13px;color:var(--ink-muted);margin-top:4px}
        .valid-until{font-family:'Montserrat',sans-serif;font-size:12px;color:var(--blue);margin-top:3px;font-weight:600}
        .parties{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:28px}
        .party-card{background:var(--white);border:1px solid var(--border);border-radius:10px;padding:20px 24px}
        .party-role{font-family:'Montserrat',sans-serif;font-size:10px;letter-spacing:.12em;text-transform:uppercase;font-weight:800;color:var(--ink-muted);margin-bottom:10px}
        .party-logo{height:28px;max-width:120px;object-fit:contain;display:block;margin-bottom:8px}
        .party-name{font-family:'Montserrat',sans-serif;font-size:17px;font-weight:700;color:var(--navy);margin-bottom:6px}
        .party-details{font-size:13px;color:var(--ink-light);line-height:1.7}
        .section-title{font-family:'Montserrat',sans-serif;font-size:10px;letter-spacing:.12em;text-transform:uppercase;font-weight:800;color:var(--ink-muted);margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid var(--border)}
        .notes-block{margin-bottom:28px;padding:20px 24px;background:var(--card-bg);border:1px solid var(--border);border-radius:10px}
        .notes-label{font-family:'Montserrat',sans-serif;font-size:10px;letter-spacing:.1em;text-transform:uppercase;font-weight:800;color:var(--ink-muted);margin-bottom:8px}
        .notes-block p{font-size:13px;color:var(--ink-light);line-height:1.7;white-space:pre-wrap}
        .dealer-note-input{width:100%;border:1px solid var(--border);border-radius:8px;padding:12px 16px;font-size:13px;color:var(--ink-light);font-family:inherit;resize:vertical;background:var(--white);outline:none;line-height:1.6;display:block;margin-bottom:28px}
        .dealer-note-input:focus{border-color:var(--blue)}
        .product-block{background:var(--white);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:12px}
        .product-block:last-of-type{margin-bottom:20px}
        .product-main{display:grid;grid-template-columns:100px 1fr auto;align-items:stretch}
        .product-img{background:var(--card-bg);display:flex;align-items:center;justify-content:center;font-size:36px;min-height:110px}
        .product-info{padding:20px 24px;border-left:1px solid var(--border)}
        .product-cat{font-family:'Montserrat',sans-serif;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--blue);font-weight:600;margin-bottom:5px}
        .product-name{font-family:'Montserrat',sans-serif;font-size:18px;font-weight:700;color:var(--navy);margin-bottom:6px;line-height:1.3}
        .product-desc{font-size:13px;color:var(--ink-light);line-height:1.6;max-width:460px}
        .product-video{display:block;position:relative;width:100%;height:120px;border-radius:8px;overflow:hidden;margin-top:12px;cursor:pointer;text-decoration:none;flex-shrink:0}
        .product-video-bg{position:absolute;inset:0;background-size:cover;background-position:center;background-color:var(--navy)}
        .product-video-overlay{position:absolute;inset:0;background:rgba(10,22,40,.55);transition:background .2s}
        .product-video:hover .product-video-overlay{background:rgba(10,22,40,.35)}
        .product-video-play{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px}
        .product-video-circle{width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,.92);display:flex;align-items:center;justify-content:center;font-size:16px;padding-left:3px;transition:transform .2s}
        .product-video:hover .product-video-circle{transform:scale(1.12)}
        .product-video-label{font-family:'Montserrat',sans-serif;font-size:11px;font-weight:700;color:#fff;letter-spacing:.07em;text-transform:uppercase}
        .price-col{padding:20px 24px;text-align:right;border-left:1px solid var(--border);display:flex;flex-direction:column;justify-content:center;min-width:160px}
        .price-label{font-family:'Montserrat',sans-serif;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-muted);font-weight:600;margin-bottom:4px}
        .price-value{font-family:'Montserrat',sans-serif;font-size:22px;font-weight:800;color:var(--navy)}
        .price-value.sm{font-size:18px}
        .price-unit{font-size:12px;color:var(--ink-muted);margin-top:2px}
        .netto-block{margin-bottom:12px;padding-bottom:12px;border-bottom:1px dashed var(--border)}
        .netto-block .price-value{color:var(--navy);font-size:18px}
        .edit-input{font-family:'Montserrat',sans-serif;font-size:20px;font-weight:800;color:var(--navy);border:none;border-bottom:2px solid var(--orange);background:transparent;text-align:right;width:120px;outline:none;padding:2px 0}
        .edit-input.sm{font-size:18px;width:100px}
        .edit-hint{font-family:'Montserrat',sans-serif;font-size:10px;color:var(--orange);font-weight:600;margin-top:3px;letter-spacing:.05em}
        .sub-items{border-top:1px solid var(--border)}
        .sub-section-label{font-family:'Montserrat',sans-serif;font-size:10px;letter-spacing:.1em;text-transform:uppercase;font-weight:800;color:var(--ink-muted);padding:12px 24px 8px;background:var(--paper)}
        .sub-item{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:16px;padding:12px 24px;border-top:1px solid var(--border)}
        .item-name{font-size:14px;color:var(--ink-light)} .item-desc{font-size:12px;color:var(--ink-muted);margin-top:2px}
        .item-qty{font-size:13px;color:var(--ink-muted);white-space:nowrap}
        .item-price{font-family:'Montserrat',sans-serif;font-size:15px;font-weight:700;color:var(--navy);text-align:right;white-space:nowrap}
        .item-price-stack{text-align:right}
        .netto-small{font-family:'Montserrat',sans-serif;font-size:11px;color:var(--navy);font-weight:600}
        .line-edit{font-family:'Montserrat',sans-serif;font-size:15px;font-weight:700;color:var(--navy);border:none;border-bottom:1.5px solid var(--orange);background:transparent;text-align:right;width:90px;outline:none}
        .sub-badge{font-family:'Montserrat',sans-serif;font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600;letter-spacing:.05em}
        .sub-badge.monthly{background:var(--green-bg);color:var(--green)}
        .sub-badge.yearly{background:var(--orange-bg);color:var(--orange)}
        .software-update-block{margin-bottom:20px}
        .software-update-banner{padding:14px 24px;background:var(--orange-bg);display:flex;align-items:center;gap:12px}
        .software-update-icon{font-size:20px;flex-shrink:0}
        .software-update-title{font-family:'Montserrat',sans-serif;font-size:11px;font-weight:700;color:var(--orange);letter-spacing:.06em;text-transform:uppercase;margin-bottom:2px}
        .software-update-sub{font-size:12px;color:var(--ink-light)}
        .acc-section{margin-top:20px;margin-bottom:20px}
        .acc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin-top:12px}
        .acc-card{background:var(--white);border:1px solid var(--border);border-radius:8px;padding:14px 16px;cursor:pointer;transition:all .15s;display:flex;align-items:flex-start;gap:10px}
        .acc-card:hover{border-color:var(--blue)}
        .acc-card.selected{border-color:var(--blue);background:var(--blue-light)}
        .acc-check{width:18px;height:18px;border-radius:4px;border:2px solid var(--border);display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px}
        .acc-card.selected .acc-check{background:var(--blue);border-color:var(--blue);color:white;font-size:11px}
        .acc-thumb{width:52px;height:52px;border-radius:6px;object-fit:cover;flex-shrink:0;display:block;background:var(--card-bg)}
        .acc-thumb-placeholder{width:52px;height:52px;border-radius:6px;background:var(--card-bg);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:20px}
        .acc-body{flex:1;min-width:0}
        .acc-name{font-family:'Montserrat',sans-serif;font-size:13px;font-weight:600;color:var(--navy);margin-bottom:2px}
        .acc-price{font-family:'Montserrat',sans-serif;font-size:14px;font-weight:700;color:var(--blue);margin-top:2px}
        .acc-more{font-family:'Montserrat',sans-serif;font-size:11px;font-weight:600;color:var(--blue);text-decoration:none;margin-top:4px;display:inline-block}
        .acc-more:hover{text-decoration:underline}
        .leasing-block{background:var(--card-bg);border:1px solid var(--border);border-radius:10px;padding:20px 24px;margin-bottom:20px}
        .leasing-title{font-family:'Montserrat',sans-serif;font-size:10px;letter-spacing:.1em;text-transform:uppercase;font-weight:800;color:var(--ink-muted);margin-bottom:12px}
        .leasing-amount{font-family:'Montserrat',sans-serif;font-size:32px;font-weight:800;color:var(--navy)}
        .leasing-sub{font-size:12px;color:var(--ink-muted);margin-top:4px}
        .leasing-disclaimer{font-size:11px;color:var(--ink-muted);margin-top:10px;line-height:1.5;font-style:italic}
        .totals-block{border-radius:12px;padding:28px 32px;margin-top:28px;color:var(--white)}
        .totals-block.dealer{background:var(--navy)} .totals-block.customer{background:var(--ink)}
        .totals-grid{display:grid;grid-template-columns:1fr auto;gap:10px 32px;align-items:baseline}
        .t-label{font-size:13px;color:rgba(255,255,255,.6)} .t-value{font-family:'Montserrat',sans-serif;font-size:16px;font-weight:700;text-align:right}
        .t-label.main{font-family:'Montserrat',sans-serif;color:rgba(255,255,255,.9);font-weight:600} .t-value.main{font-size:26px;font-weight:800}
        .t-label.avance{font-family:'Montserrat',sans-serif;color:rgba(255,255,255,.9);font-weight:600}
        .t-value.avance{color:#81c784;font-size:18px;font-weight:800} .t-value.avance.neg{color:#ef9a9a}
        .avance-pct{font-size:12px;opacity:.75;margin-left:8px;font-weight:600}
        .t-divider{grid-column:1/-1;border:none;border-top:1px solid rgba(255,255,255,.15);margin:8px 0}
        .totals-note{font-size:12px;color:rgba(255,255,255,.4);margin-top:16px}
        .dealer-tools{margin-top:28px;background:var(--blue-light);border:1px solid #c0d8ee;border-radius:12px;padding:24px 28px}
        .dealer-tools h3{font-family:'Montserrat',sans-serif;font-size:14px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--navy);margin-bottom:6px}
        .dealer-tools p{font-size:13px;color:var(--ink-light);margin-bottom:18px}
        .tools-row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
        .btn{font-family:'Montserrat',sans-serif;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:10px 22px;border-radius:27px;border:none;cursor:pointer;transition:all .15s;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
        .btn-primary{background:var(--blue);color:white} .btn-primary:hover{background:var(--navy)}
        .btn-secondary{background:white;color:var(--blue);border:1px solid #c0d8ee} .btn-secondary:hover{background:var(--paper)}
        .customer-action{margin-top:28px;text-align:center;padding:32px;background:var(--white);border:1px solid var(--border);border-radius:12px}
        .customer-action p{font-size:14px;color:var(--ink-light);margin-bottom:16px}
        .accept-btn{font-family:'Montserrat',sans-serif;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:14px 40px;background:var(--blue);color:white;border:none;border-radius:27px;cursor:pointer;transition:background .15s}
        .accept-btn:hover{background:var(--navy)}
        .quote-footer{margin-top:48px;padding-top:20px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
        .footer-brand{font-family:'Montserrat',sans-serif;font-size:11px;font-weight:600;color:var(--ink-muted)} .footer-brand strong{color:var(--navy)}
        .footer-contact{font-size:11px;color:var(--ink-muted);text-align:right}
        @media print{.dealer-tools,.customer-action,.no-print{display:none!important} body{background:white}}
        @media(max-width:600px){.product-main{grid-template-columns:1fr} .price-col{border-left:none;border-top:1px solid var(--border);text-align:left} .parties{grid-template-columns:1fr}}
      `}</style>

      <div className="page">

        {/* ── View badge ─────────────────────────────────────────────────────── */}
        <div className={`view-badge ${isDealer ? 'dealer' : 'customer'}`}>
          <span className="dot" />
          {isDealer ? tr.dealerPortalLabel : tr.customerPortalLabel}
        </div>

        {/* ── Quote header ───────────────────────────────────────────────────── */}
        <div className="quote-header">
          <div>
            {/* Dealer view: CEPELO logo + dealer logo side by side
                Customer view: dealer logo only (no CEPELO branding) */}
            {isDealer ? (
              <div style={{display:'flex',alignItems:'center',gap:20,marginBottom:6}}>
                <img src="/cepelo-logo.png" alt="CEPELO" style={{height:40,display:'block'}} />
                {dealerLogoUrl && (
                  <img
                    src={dealerLogoUrl}
                    alt={quote.dealer_name || ''}
                    style={{height:36,maxWidth:130,objectFit:'contain',display:'block'}}
                    onError={e => { e.target.style.display = 'none' }}
                  />
                )}
              </div>
            ) : (
              dealerLogoUrl
                ? <img
                    src={dealerLogoUrl}
                    alt={quote.dealer_name || ''}
                    style={{height:40,maxWidth:160,objectFit:'contain',display:'block',marginBottom:6}}
                    onError={e => { e.target.style.display = 'none' }}
                  />
                : null
            )}
            {/* Tagline only shown in dealer view */}
            {isDealer && <div className="tagline">{tr.tagline}</div>}
            {isDealer && quote.dealer_name && (
              <div className="header-dealer">
                <strong>{quote.dealer_name}</strong>
                {quote.dealer_email && <> · {quote.dealer_email}</>}
                {quote.dealer_phone && <> · {quote.dealer_phone}</>}
              </div>
            )}
          </div>
          <div className="quote-meta">
            <div className="quote-label">{tr.quote}</div>
            <div className="quote-number">#{(quote.token || quote.customer_token)?.slice(-6).toUpperCase()}</div>
            {/* Shopify order reference (issue #5) */}
            {shopifyRef && <div className="quote-shopify-ref">Shopify {shopifyRef}</div>}
            <div className="quote-date">{dateStr(new Date().toISOString())}</div>
            {quote.valid_until && <div className="valid-until">{tr.validUntil} {dateStr(quote.valid_until)}</div>}
          </div>
        </div>

        {/* ── Parties ────────────────────────────────────────────────────────── */}
        <div className="parties" style={!isDealer ? {gridTemplateColumns:'1fr',maxWidth:400} : {}}>
          {isDealer && (
            <div className="party-card">
              <div className="party-role">Forhandler</div>
              <div className="party-name">{quote.dealer_name || '—'}</div>
              <div className="party-details">
                {quote.dealer_email && <>{quote.dealer_email}<br /></>}
                {quote.dealer_phone && <>{quote.dealer_phone}</>}
              </div>
            </div>
          )}
          <div className="party-card">
            <div className="party-role">Slutkunde</div>
            <div className="party-name">{quote.recipient_company || quote.recipient_name || '—'}</div>
            <div className="party-details">
              {quote.recipient_name && quote.recipient_name !== quote.recipient_company && <>{quote.recipient_name}<br /></>}
              {quote.recipient_email && <>{quote.recipient_email}<br /></>}
              {quote.recipient_phone && <>{quote.recipient_phone}</>}
            </div>
          </div>
        </div>

        {/* ── Seller note — moved to TOP (issue #3) ──────────────────────────── */}
        {quote.notes && (
          <div className="notes-block">
            <div className="notes-label">{tr.sellerNote}</div>
            <p>{quote.notes}</p>
          </div>
        )}

        {/* ── Dealer editable note textarea (issue #13, local state only) ───── */}
        {isDealer && (
          <div className="no-print">
            <textarea
              className="dealer-note-input"
              value={dealerNote}
              onChange={e => setDealerNote(e.target.value)}
              placeholder={
                lang === 'no' ? 'Legg til en personlig melding til kunden før du videresender tilbudet…' :
                lang === 'is' ? 'Bættu við persónulegri skilaboð til viðskiptavinar…' :
                'Tilføj en personlig besked til kunden inden du videresender tilbuddet…'
              }
              rows={3}
            />
          </div>
        )}

        {/* ── Combined product list sorted by price desc (issue #9) ─────────── */}
        {allProductItems.map((item, idx) => {
          const liIdx = item._liIdx
          // State helpers for editable gross price (issue #6 — onBlur formatting)
          const grossState = item._isMain
            ? mainGross
            : (lineGross[liIdx] ?? formatPrice((item.gross_price || 0) * (item.quantity || 1), lang))

          const handleGrossChange = item._isMain
            ? (val) => setMainGross(val)
            : (val) => { const n = [...lineGross]; n[liIdx] = val; setLineGross(n) }

          const handleGrossBlur = item._isMain
            ? (e) => setMainGross(formatPrice(parsePrice(e.target.value), lang))
            : (e) => { const n = [...lineGross]; n[liIdx] = formatPrice(parsePrice(e.target.value), lang); setLineGross(n) }

          const netPrice    = item._isMain ? quote.main_product?.net_price : item.net_price
          const showSubItems = item._isMain && (hardware.length > 0 || software.length > 0 || subscriptions.length > 0)

          return (
            <div className="product-block" key={idx}>
              <div className="product-main">
                {/* Thumbnail */}
                <div className="product-img">
                  {item.image_url
                    ? <img src={item.image_url} style={{width:'100%',height:'100%',objectFit:'cover'}} alt={item.name} />
                    : <span style={{fontSize:32}}>{item._isMain ? '⚙️' : '📦'}</span>
                  }
                </div>

                {/* Product info */}
                <div className="product-info">
                  <div className="product-cat">{item.product_type || (item._isMain ? quote.category : item.sku)}</div>
                  <div className="product-name" style={item._isMain ? {} : {fontSize:17}}>{item.name}</div>
                  <div className="product-desc">
                    {shortDesc(item.description)}
                    {item.shopify_handle && (
                      <>{' '}<a href={`https://cepelo.dk/products/${item.shopify_handle}`} target="_blank" rel="noopener noreferrer" style={{color:'var(--blue)',textDecoration:'none',whiteSpace:'nowrap'}}>Læs mere →</a></>
                    )}
                  </div>
                  {/* Video thumbnail card */}
                  {item.video_url && (
                    <a href={item.video_url} target="_blank" rel="noopener noreferrer" className="product-video">
                      <div className="product-video-bg" style={item.image_url ? {backgroundImage:`url(${item.image_url})`} : {}} />
                      <div className="product-video-overlay" />
                      <div className="product-video-play">
                        <div className="product-video-circle">▶</div>
                        <span className="product-video-label">Se video</span>
                      </div>
                    </a>
                  )}
                  {!item._isMain && item.quantity > 1 && (
                    <div style={{fontSize:12,color:'var(--ink-muted)',marginTop:4}}>Antal: {item.quantity}</div>
                  )}
                </div>

                {/* Price column */}
                <div className="price-col">
                  {isDealer ? (
                    <>
                      <div className="netto-block">
                        <div className="price-label">{tr.netPrice}</div>
                        <div className={`price-value${item._isMain ? '' : ' sm'}`}>{formatPrice(netPrice, lang)}</div>
                        <div className="price-unit">{tr.exclVat}</div>
                      </div>
                      <div>
                        <div className="price-label">{tr.grossPrice}</div>
                        {/* Editable gross with blur formatting (issue #6) */}
                        <input
                          className={`edit-input${item._isMain ? '' : ' sm'}`}
                          value={grossState}
                          onChange={e => handleGrossChange(e.target.value)}
                          onBlur={handleGrossBlur}
                        />
                        <div className="edit-hint">{tr.editable}</div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="price-label">{tr.quote}</div>
                      <div className={`price-value${item._isMain ? '' : ' sm'}`}>{formatPrice(item.gross_price || item.net_price, lang)}</div>
                      <div className="price-unit">{tr.exclVat}</div>
                    </>
                  )}
                </div>
              </div>

              {/* Sub-items: accessories, software, subscriptions — main product only */}
              {showSubItems && (
                <div className="sub-items">
                  {hardware.length > 0 && (
                    <>
                      <div className="sub-section-label">{tr.accessories}</div>
                      {hardware.map((hw, hIdx) => {
                        const hwLiIdx = (quote.line_items || []).indexOf(hw)
                        return (
                          <div className="sub-item" key={hIdx}>
                            <div>
                              <div className="item-name">{hw.name}</div>
                              {hw.description && <div className="item-desc">{hw.description}</div>}
                            </div>
                            <div className="item-qty">{hw.qty || 1} stk.</div>
                            {isDealer
                              ? <div className="item-price-stack">
                                  <div className="netto-small">Netto: {formatPrice(hw.net_price, lang)}</div>
                                  <input
                                    className="line-edit"
                                    value={lineGross[hwLiIdx] || ''}
                                    onChange={e => { const n=[...lineGross]; n[hwLiIdx]=e.target.value; setLineGross(n) }}
                                    onBlur={e => { const n=[...lineGross]; n[hwLiIdx]=formatPrice(parsePrice(e.target.value), lang); setLineGross(n) }}
                                  />
                                </div>
                              : <div className="item-price">{formatPrice(hw.gross_price, lang)}</div>
                            }
                          </div>
                        )
                      })}
                    </>
                  )}
                  {software.length > 0 && (
                    <>
                      <div className="sub-section-label">{tr.software}</div>
                      {software.map((sw, sIdx) => {
                        const swLiIdx = (quote.line_items || []).indexOf(sw)
                        return (
                          <div className="sub-item" key={sIdx}>
                            <div><div className="item-name">{sw.name}</div></div>
                            <div className="item-qty">1 lic.</div>
                            {isDealer
                              ? <div className="item-price-stack">
                                  <div className="netto-small">Netto: {formatPrice(sw.net_price, lang)}</div>
                                  <input
                                    className="line-edit"
                                    value={lineGross[swLiIdx] || ''}
                                    onChange={e => { const n=[...lineGross]; n[swLiIdx]=e.target.value; setLineGross(n) }}
                                    onBlur={e => { const n=[...lineGross]; n[swLiIdx]=formatPrice(parsePrice(e.target.value), lang); setLineGross(n) }}
                                  />
                                </div>
                              : <div className="item-price">{formatPrice(sw.gross_price, lang)}</div>
                            }
                          </div>
                        )
                      })}
                    </>
                  )}
                  {subscriptions.length > 0 && (
                    <>
                      <div className="sub-section-label">{tr.subscriptions}</div>
                      {subscriptions.map((sub, subIdx) => (
                        <div className="sub-item" key={subIdx}>
                          <div>
                            <div className="item-name">{sub.name}</div>
                            {sub.description && <div className="item-desc">{sub.description}</div>}
                          </div>
                          <div className="item-qty">
                            <span className={`sub-badge ${sub.badge || 'monthly'}`}>
                              {sub.badge === 'yearly' ? tr.yearly : tr.monthly}
                            </span>
                          </div>
                          <div className="item-price">
                            {formatPrice(sub.gross_price, lang)}
                            {sub.badge === 'yearly' ? tr.perYear : tr.perMonth}
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {/* ── Software update section — Autodiagnose only (issue #11) ────────── */}
        {isAutodiagnose && (
          <div className="software-update-block">
            <div className="section-title" style={{marginTop:8}}>
              {lang === 'no' ? 'Programvareoppdateringer' : lang === 'is' ? 'Hugbúnaðaruppfærslur' : 'Softwareopdateringer'}
            </div>
            <div className="product-block" style={{marginBottom:20}}>
              <div className="software-update-banner">
                <span className="software-update-icon">🔄</span>
                <div>
                  <div className="software-update-title">
                    {lang === 'no' ? 'Programvare holdes oppdatert' : lang === 'is' ? 'Hugbúnaður uppfærður reglulega' : 'Software holdes opdateret'}
                  </div>
                  <div className="software-update-sub">
                    {lang === 'no'
                      ? 'Ny diagnosedatabase · Nye bilmodeller · Forbedrede funksjoner'
                      : lang === 'is'
                      ? 'Ný greiningargagnagrunnur · Nýjar bílategundir · Bætt virkni'
                      : 'Opdateret diagnosedatabase · Nye bilmodeller · Forbedrede funktioner'}
                  </div>
                </div>
              </div>
              {subscriptions.map((sub, subIdx) => {
                const subName = typeof sub.name === 'object' ? (sub.name[lang] || sub.name.da) : sub.name
                const subDesc = typeof sub.description === 'object' ? (sub.description[lang] || sub.description.da) : sub.description
                return (
                  <div className="sub-item" key={subIdx} style={{borderTop:'1px solid var(--border)'}}>
                    <div>
                      <div className="item-name">{subName}</div>
                      {subDesc && <div className="item-desc">{subDesc}</div>}
                    </div>
                    <span className={`sub-badge ${sub.badge || 'yearly'}`}>
                      {sub.badge === 'yearly' ? tr.yearly : tr.monthly}
                    </span>
                    <div className="item-price">
                      {formatPrice(sub.gross_price, lang)}
                      {sub.badge === 'yearly' ? tr.perYear : tr.perMonth}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── Manual line items (fragt, montering etc.) ──────────────────────── */}
        {manualLineItems.length > 0 && (
          <>
            <div className="section-title" style={{marginTop:24}}>Øvrige poster</div>
            <div className="product-block" style={{marginBottom:8}}>
              {manualLineItems.map((item, idx) => (
                <div key={idx} className="sub-item" style={{borderTop:idx===0?'none':undefined}}>
                  <div><div className="item-name" style={{fontSize:15}}>{item.name}</div></div>
                  <div className="item-qty">1 stk.</div>
                  <div className="item-price">{formatPrice(item.gross_price || item.net_price, lang)}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── Accessories grid ───────────────────────────────────────────────── */}
        {accessories.length > 0 && (
          <div className="acc-section no-print">
            <div className="section-title">{tr.accessories}</div>
            <div className="acc-grid">
              {accessories.map((acc, idx) => {
                const selected = !!selectedAccessories.find(a => a.sku === acc.sku)
                const name = typeof acc.name === 'object' ? (acc.name[lang] || acc.name.da) : acc.name
                return (
                  <div key={idx} className={`acc-card ${selected ? 'selected' : ''}`} onClick={() => toggleAccessory(acc)}>
                    <div className="acc-check">{selected && '✓'}</div>
                    {acc.image_url
                      ? <img src={acc.image_url} alt={name} className="acc-thumb" />
                      : <div className="acc-thumb-placeholder">📦</div>
                    }
                    <div className="acc-body">
                      <div className="acc-name">{name}</div>
                      <div className="acc-price">
                        {formatPrice(acc.gross_price, lang)}
                        {acc.badge === 'yearly' ? tr.perYear : acc.badge === 'monthly' ? tr.perMonth : ''}
                      </div>
                      {acc.shopify_handle && (
                        <a
                          href={`https://cepelo.dk/products/${acc.shopify_handle}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="acc-more"
                          onClick={e => e.stopPropagation()}
                        >
                          Læs mere →
                        </a>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── Leasing indicator ──────────────────────────────────────────────── */}
        {totalGrossOneTime > 0 && (
          <div className="leasing-block">
            <div className="leasing-title">{tr.leasingTitle}</div>
            <div className="leasing-amount">
              {formatPrice(leasing.monthlyPayment, lang)}
              <span style={{fontSize:16,color:'var(--ink-muted)'}}>{tr.perMonth}</span>
            </div>
            <div className="leasing-sub">
              {leasing.termMonths} {tr.leasingMonths} · {lang === 'da' ? 'Restværdi' : lang === 'no' ? 'Restverdi' : 'Leifvirði'}: {formatPrice(leasing.residualValue, lang)}
            </div>
            <div className="leasing-disclaimer">{leasing.disclaimer[lang]}</div>
          </div>
        )}

        {/* ── Totals ─────────────────────────────────────────────────────────── */}
        <div className={`totals-block ${isDealer ? 'dealer' : 'customer'}`}>
          <div className="totals-grid">
            {isDealer ? (
              <>
                {/* Netto i alt — fixed from DB */}
                <div className="t-label">
                  {lang === 'no' ? 'Nettopris totalt' : lang === 'is' ? 'Nettóverð alls' : 'Nettopris i alt'}
                </div>
                <div className="t-value">{formatPrice(totalNetOneTime, lang)}</div>

                {/* Brutto i alt — updates live as dealer edits prices */}
                <div className="t-label main">
                  {lang === 'no' ? 'Bruttopris totalt' : lang === 'is' ? 'Heildarverð' : 'Bruttopris i alt'}
                </div>
                <div className="t-value main">{formatPrice(totalGrossOneTime, lang)}</div>

                <hr className="t-divider" />

                {/* Avance — green when positive, red when below net */}
                <div className="t-label avance">
                  {lang === 'no' ? 'Avanse' : lang === 'is' ? 'Framlegð' : 'Avance'}
                </div>
                <div className={`t-value avance${avanceAmount < 0 ? ' neg' : ''}`}>
                  {avanceAmount < 0 ? '−' : ''}{formatPrice(Math.abs(avanceAmount), lang)}
                  <span className="avance-pct">{avancePct >= 0 ? '+' : ''}{avancePct}%</span>
                </div>
              </>
            ) : (
              <>
                {/* Customer view: brutto → VAT → total incl. VAT */}
                <div className="t-label">{tr.subtotal}</div>
                <div className="t-value">{formatPrice(totalGrossOneTime, lang)}</div>
                <div className="t-label">{tr.vat}</div>
                <div className="t-value">{formatPrice(calcVat(totalGrossOneTime, lang), lang)}</div>
                <hr className="t-divider" />
                <div className="t-label main">{tr.totalInclVat}</div>
                <div className="t-value main">{formatPrice(addVat(totalGrossOneTime, lang), lang)}</div>
              </>
            )}
          </div>
          <div className="totals-note">{isDealer ? `${tr.allPricesExcl} · ${tr.netPricesNote}` : tr.paymentTerms}</div>
        </div>

        {/* ── Dealer tools — redesigned (issue #7) ───────────────────────────── */}
        {isDealer && (
          <div className="dealer-tools no-print">
            <h3>{tr.forwardTitle}</h3>
            <p>{tr.forwardDesc}</p>
            <div className="tools-row">
              {/* Open quote again in new tab */}
              <a className="btn btn-secondary" href={`/quote/${quote.token}`} target="_blank" rel="noopener noreferrer">
                ↗ Åbn tilbud igen
              </a>
              {/* Send to customer via mailto (includes dealer's note from textarea) */}
              <button
                className="btn btn-primary"
                onClick={() => {
                  const customerUrl = window.location.origin + '/quote/' + quote.customer_token
                  const recipientName = quote.recipient_company || quote.recipient_name || ''
                  const subject = encodeURIComponent(
                    (lang === 'no' ? 'Tilbud fra CEPELO' : 'Tilbud fra CEPELO') +
                    (shopifyRef ? ' – ' + shopifyRef : '')
                  )
                  const greeting = recipientName ? `Kære ${recipientName},\n\n` : ''
                  const note = dealerNote ? dealerNote + '\n\n' : ''
                  const body = encodeURIComponent(
                    greeting +
                    note +
                    (lang === 'no' ? 'Se tilbudet fra CEPELO her:\n' : 'Se tilbuddet fra CEPELO her:\n') +
                    customerUrl +
                    '\n\n' + (lang === 'no' ? 'Med vennlig hilsen' : 'Med venlig hilsen') +
                    '\n' + (quote.dealer_name || 'CEPELO Salgsteam')
                  )
                  const mailto = `mailto:${quote.recipient_email || ''}?subject=${subject}&body=${body}`
                  window.open(mailto)
                }}
              >
                ✉ Send til kunde
              </button>
            </div>
          </div>
        )}

        {/* ── Customer accept / contact ───────────────────────────────────────── */}
        {!isDealer && (
          <div className="customer-action no-print">
            <p>{tr.contactText} <strong>{quote.sender_name || quote.dealer_name || 'CEPELO'}</strong> · {quote.sender_email}</p>
            <button className="accept-btn" onClick={handleAccept} disabled={acceptLoading} style={acceptLoading ? {opacity:.7,cursor:'wait'} : {}}>
              {acceptLoading ? '…' : `✓ ${tr.acceptQuote}`}
            </button>
          </div>
        )}

        {/* ── Footer ─────────────────────────────────────────────────────────── */}
        <div className="quote-footer">
          <div className="footer-brand"><strong>CEPELO A/S</strong> · Nibevej 54, 9200 Aalborg SV</div>
          <div className="footer-contact">+45 98 18 09 00 · info@cepelo.dk · cepelo.dk</div>
        </div>

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

  // ── 1. Try dealer token ──────────────────────────────────────────────────
  const { data: dealerQuote, error: dealerError } = await adminClient
    .from('quotes')
    .select('*')
    .eq('token', params.token)
    .single()

  if (!dealerError && dealerQuote) {
    // Dealer access — return full row including customer_token (needed to share the link)
    return { props: { quote: dealerQuote } }
  }

  // ── 2. Try customer token ────────────────────────────────────────────────
  const { data: custQuote, error: custError } = await adminClient
    .from('quotes')
    .select('*')
    .eq('customer_token', params.token)
    .single()

  if (custError || !custQuote) return { props: { quote: null } }

  // Customer access — strip the dealer token so customers cannot derive the dealer URL
  const { token: _dealerToken, ...safeQuote } = custQuote
  return { props: { quote: { ...safeQuote, type: 'customer' } } }
}
