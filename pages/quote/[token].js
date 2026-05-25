import { useState, useEffect } from 'react'
import Head from 'next/head'
import { supabase } from '../../lib/supabase'
import { getT } from '../../lib/translations'
import { formatPrice, addVat, calcVat, parsePrice } from '../../lib/format'
import { calcLeasing } from '../../lib/leasing'

export default function QuotePage({ quote }) {
  const lang = quote?.lang || 'da'
  const tr = getT(lang)
  const isDealer = quote?.type === 'dealer'
  const [mainGross, setMainGross] = useState(quote?.main_product?.gross_price || 0)
  const [lineGross, setLineGross] = useState((quote?.line_items || []).map(i => i.gross_price || 0))
  const [selectedAccessories, setSelectedAccessories] = useState([])

  useEffect(() => {
    if (!quote?.token) return
    supabase.from('quotes').update({ opened_at: new Date().toISOString() }).eq('token', quote.token).then(() => {})
  }, [quote?.token])

  if (!quote) return (
    <div style={{ fontFamily: 'Barlow, sans-serif', padding: 40, textAlign: 'center', color: '#333' }}>
      <p>Tilbud ikke fundet eller udløbet.</p>
    </div>
  )

  const accessories = quote.available_accessories || []
  const hardware = (quote.line_items || []).filter(i => i.type === 'accessory')
  const software = (quote.line_items || []).filter(i => i.type === 'software')
  const subscriptions = (quote.line_items || []).filter(i => i.type === 'subscription')

  const selectedTotal = selectedAccessories.reduce((sum, acc) => sum + (parsePrice(acc.gross_price) || 0), 0)
  const totalGrossOneTime = parsePrice(mainGross) +
    lineGross.filter((_, idx) => (quote.line_items || [])[idx]?.type !== 'subscription').reduce((a, v) => a + parsePrice(v), 0) +
    selectedTotal

  const leasing = calcLeasing(totalGrossOneTime)
  const dateStr = (iso) => { if (!iso) return ''; return new Date(iso).toLocaleDateString(lang === 'is' ? 'is-IS' : lang === 'no' ? 'nb-NO' : 'da-DK', { day: 'numeric', month: 'long', year: 'numeric' }) }

  const toggleAccessory = (acc) => {
    setSelectedAccessories(prev => prev.find(a => a.sku === acc.sku) ? prev.filter(a => a.sku !== acc.sku) : [...prev, acc])
  }

  const handleAccept = async () => {
    await supabase.from('quotes').update({ accepted_at: new Date().toISOString(), status: 'accepted' }).eq('token', quote.token)
    alert(lang === 'no' ? 'Tilbudet er akseptert!' : lang === 'is' ? 'Tilboðið hefur verið samþykkt!' : 'Tilbuddet er accepteret!')
  }

  return (
    <>
      <Head>
        <title>{tr.quote} #{quote.token?.slice(-6).toUpperCase()}</title>
        <link href="https://fonts.googleapis.com/css2?family=Barlow:wght@300;400;500;600&family=Barlow+Condensed:wght@300;400;600&display=swap" rel="stylesheet" />
      </Head>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        :root{--ink:#1a1a24;--ink-light:#4a4a58;--ink-muted:#888899;--paper:#f8f7f4;--paper-warm:#f0ede6;--blue:#0077b6;--blue-light:#e0f0fa;--dealer-bg:#005a8e;--border:#ddd8ce;--white:#fff;--green:#2e7d32;--green-bg:#e8f5e9;--gold:#b8962e;--gold-bg:#f0e8d0}
        body{font-family:'Barlow',sans-serif;background:var(--paper);color:var(--ink)}
        .page{max-width:860px;margin:0 auto;padding:48px 32px 80px}
        .view-badge{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;padding:5px 12px;border-radius:20px;margin-bottom:28px}
        .view-badge.dealer{background:var(--blue-light);color:var(--dealer-bg)}
        .view-badge.customer{background:var(--paper-warm);color:var(--ink-light);border:1px solid var(--border)}
        .dot{width:6px;height:6px;border-radius:50%}
        .dealer .dot{background:var(--dealer-bg)} .customer .dot{background:var(--blue)}
        .quote-header{display:grid;grid-template-columns:1fr auto;align-items:start;gap:32px;padding-bottom:36px;border-bottom:1px solid var(--border);margin-bottom:40px}
        .tagline{font-size:12px;color:var(--ink-muted);letter-spacing:.08em;text-transform:uppercase;margin-top:4px}
        .quote-meta{text-align:right}
        .quote-label{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-muted);margin-bottom:6px}
        .quote-number{font-family:'Barlow Condensed',sans-serif;font-size:22px;font-weight:300}
        .quote-date{font-size:13px;color:var(--ink-muted);margin-top:4px}
        .valid-until{font-size:12px;color:var(--blue);margin-top:3px;font-weight:500}
        .parties{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:40px}
        .party-card{background:var(--white);border:1px solid var(--border);border-radius:10px;padding:20px 24px}
        .party-role{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-muted);margin-bottom:10px}
        .party-name{font-family:'Barlow Condensed',sans-serif;font-size:19px;font-weight:400;margin-bottom:6px}
        .party-details{font-size:13px;color:var(--ink-light);line-height:1.7}
        .section-title{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-muted);margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid var(--border)}
        .product-block{background:var(--white);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:20px}
        .product-main{display:grid;grid-template-columns:100px 1fr auto;align-items:stretch}
        .product-img{background:var(--paper-warm);display:flex;align-items:center;justify-content:center;font-size:36px;min-height:110px}
        .product-info{padding:20px 24px;border-left:1px solid var(--border)}
        .product-cat{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--blue);margin-bottom:5px}
        .product-name{font-family:'Barlow Condensed',sans-serif;font-size:20px;font-weight:400;margin-bottom:6px;line-height:1.3}
        .product-desc{font-size:13px;color:var(--ink-light);line-height:1.6;max-width:460px}
        .price-col{padding:20px 24px;text-align:right;border-left:1px solid var(--border);display:flex;flex-direction:column;justify-content:center;min-width:160px}
        .price-label{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-muted);margin-bottom:4px}
        .price-value{font-family:'Barlow Condensed',sans-serif;font-size:22px;font-weight:300}
        .price-unit{font-size:12px;color:var(--ink-muted);margin-top:2px}
        .netto-block{margin-bottom:12px;padding-bottom:12px;border-bottom:1px dashed var(--border)}
        .netto-block .price-value{color:var(--dealer-bg);font-size:18px}
        .edit-input{font-family:'Barlow Condensed',sans-serif;font-size:22px;font-weight:300;color:var(--ink);border:none;border-bottom:2px solid var(--gold);background:transparent;text-align:right;width:120px;outline:none;padding:2px 0}
        .edit-hint{font-size:10px;color:var(--gold);margin-top:3px;letter-spacing:.05em}
        .sub-items{border-top:1px solid var(--border)}
        .sub-section-label{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-muted);padding:12px 24px 8px;background:var(--paper)}
        .sub-item{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:16px;padding:12px 24px;border-top:1px solid var(--border)}
        .item-name{font-size:14px} .item-desc{font-size:12px;color:var(--ink-muted);margin-top:2px}
        .item-qty{font-size:13px;color:var(--ink-light);white-space:nowrap}
        .item-price{font-family:'Barlow Condensed',sans-serif;font-size:16px;font-weight:300;text-align:right;white-space:nowrap}
        .item-price-stack{text-align:right}
        .netto-small{font-size:11px;color:var(--dealer-bg);font-weight:500}
        .line-edit{font-family:'Barlow Condensed',sans-serif;font-size:15px;font-weight:300;border:none;border-bottom:1.5px solid var(--gold);background:transparent;text-align:right;width:90px;outline:none}
        .sub-badge{font-size:10px;padding:2px 8px;border-radius:10px;font-weight:500;letter-spacing:.05em}
        .sub-badge.monthly{background:var(--green-bg);color:var(--green)}
        .sub-badge.yearly{background:var(--gold-bg);color:var(--gold)}
        .acc-section{margin-top:20px;margin-bottom:20px}
        .acc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin-top:12px}
        .acc-card{background:var(--white);border:1px solid var(--border);border-radius:8px;padding:14px 16px;cursor:pointer;transition:all .15s;display:flex;align-items:flex-start;gap:10px}
        .acc-card:hover{border-color:var(--blue)}
        .acc-card.selected{border-color:var(--blue);background:var(--blue-light)}
        .acc-check{width:18px;height:18px;border-radius:4px;border:2px solid var(--border);display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px}
        .acc-card.selected .acc-check{background:var(--blue);border-color:var(--blue);color:white;font-size:11px}
        .acc-name{font-size:13px;font-weight:500;color:var(--ink);margin-bottom:3px}
        .acc-price{font-family:'Barlow Condensed',sans-serif;font-size:15px;color:var(--blue)}
        .leasing-block{background:var(--paper-warm);border:1px solid var(--border);border-radius:10px;padding:20px 24px;margin-bottom:20px}
        .leasing-title{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-muted);margin-bottom:12px}
        .leasing-amount{font-family:'Barlow Condensed',sans-serif;font-size:32px;font-weight:300;color:var(--ink)}
        .leasing-sub{font-size:12px;color:var(--ink-muted);margin-top:4px}
        .leasing-disclaimer{font-size:11px;color:var(--ink-muted);margin-top:10px;line-height:1.5;font-style:italic}
        .totals-block{border-radius:12px;padding:28px 32px;margin-top:28px;color:var(--white)}
        .totals-block.dealer{background:var(--dealer-bg)} .totals-block.customer{background:var(--ink)}
        .totals-grid{display:grid;grid-template-columns:1fr auto;gap:10px 32px;align-items:baseline}
        .t-label{font-size:13px;color:rgba(255,255,255,.6)} .t-value{font-family:'Barlow Condensed',sans-serif;font-size:16px;font-weight:300;text-align:right}
        .t-label.main{color:rgba(255,255,255,.9);font-weight:500} .t-value.main{font-size:28px}
        .t-divider{grid-column:1/-1;border:none;border-top:1px solid rgba(255,255,255,.15);margin:8px 0}
        .totals-note{font-size:12px;color:rgba(255,255,255,.4);margin-top:16px}
        .dealer-tools{margin-top:28px;background:var(--blue-light);border:1px solid #c8d8e8;border-radius:12px;padding:24px 28px}
        .dealer-tools h3{font-family:'Barlow Condensed',sans-serif;font-size:18px;font-weight:400;color:var(--dealer-bg);margin-bottom:6px}
        .dealer-tools p{font-size:13px;color:var(--ink-light);margin-bottom:18px}
        .tools-row{display:flex;gap:12px;flex-wrap:wrap}
        .btn{font-family:'Barlow',sans-serif;font-size:13px;font-weight:500;padding:10px 20px;border-radius:8px;border:none;cursor:pointer;transition:all .15s}
        .btn-primary{background:var(--dealer-bg);color:white} .btn-primary:hover{background:#004a78}
        .btn-secondary{background:white;color:var(--dealer-bg);border:1px solid #c8d8e8} .btn-secondary:hover{background:var(--paper)}
        .customer-action{margin-top:28px;text-align:center;padding:32px;background:var(--white);border:1px solid var(--border);border-radius:12px}
        .customer-action p{font-size:14px;color:var(--ink-light);margin-bottom:16px}
        .accept-btn{font-family:'Barlow',sans-serif;font-size:14px;font-weight:500;padding:14px 36px;background:var(--blue);color:white;border:none;border-radius:8px;cursor:pointer}
        .accept-btn:hover{background:var(--dealer-bg)}
        .notes-block{margin-top:28px;padding:20px 24px;background:var(--paper-warm);border:1px solid var(--border);border-radius:10px}
        .notes-label{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-muted);margin-bottom:8px}
        .notes-block p{font-size:13px;color:var(--ink-light);line-height:1.7}
        .quote-footer{margin-top:48px;padding-top:20px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
        .footer-brand{font-size:11px;color:var(--ink-muted)} .footer-brand strong{color:var(--ink-light)}
        .footer-contact{font-size:11px;color:var(--ink-muted);text-align:right}
        @media print{.dealer-tools,.customer-action,.no-print{display:none!important} body{background:white}}
        @media(max-width:600px){.product-main{grid-template-columns:1fr} .price-col{border-left:none;border-top:1px solid var(--border);text-align:left} .parties{grid-template-columns:1fr}}
      `}</style>

      <div className="page">
        <div className={`view-badge ${isDealer ? 'dealer' : 'customer'}`}>
          <span className="dot" />
          {isDealer ? tr.dealerPortalLabel : tr.customerPortalLabel}
        </div>

        <div className="quote-header">
          <div>
            <img src="data:image/png;base64,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" alt="CEPELO" style={{height:40,display:'block',marginBottom:6}} />
            <div className="tagline">{tr.tagline}</div>
          </div>
          <div className="quote-meta">
            <div className="quote-label">{tr.quote}</div>
            <div className="quote-number">#{quote.token?.slice(-6).toUpperCase()}</div>
            <div className="quote-date">{dateStr(new Date().toISOString())}</div>
            {quote.valid_until && <div className="valid-until">{tr.validUntil} {dateStr(quote.valid_until)}</div>}
          </div>
        </div>

        <div className="parties">
          <div className="party-card">
            <div className="party-role">{tr.from}</div>
            <div className="party-name">{isDealer ? 'CEPELO A/S' : (quote.dealer_name || 'CEPELO A/S')}</div>
            <div className="party-details">{isDealer ? <>Industrivej 12, 8600 Silkeborg<br />salg@cepelo.dk · +45 86 82 00 00</> : <>{quote.sender_email}<br />{quote.sender_phone}</>}</div>
          </div>
          <div className="party-card">
            <div className="party-role">{tr.to}</div>
            <div className="party-name">{quote.recipient_company || quote.recipient_name}</div>
            <div className="party-details">{quote.recipient_name && <>{quote.recipient_name}<br /></>}{quote.recipient_email}<br />{quote.recipient_phone}</div>
          </div>
        </div>

        {quote.main_product && <>
          <div className="section-title">{tr.mainProduct}</div>
          <div className="product-block">
            <div className="product-main">
              <div className="product-img">{quote.main_product.image_url ? <img src={quote.main_product.image_url} style={{width:'100%',height:'100%',objectFit:'cover'}} /> : '⚙️'}</div>
              <div className="product-info">
                <div className="product-cat">{quote.category}</div>
                <div className="product-name">{quote.main_product.name}</div>
                <div className="product-desc">{quote.main_product.description}</div>
              </div>
              <div className="price-col">
                {isDealer ? <>
                  <div className="netto-block">
                    <div className="price-label">{tr.netPrice}</div>
                    <div className="price-value">{formatPrice(quote.main_product.net_price, lang)}</div>
                    <div className="price-unit">{tr.exclVat}</div>
                  </div>
                  <div>
                    <div className="price-label">{tr.grossPrice}</div>
                    <input className="edit-input" value={mainGross} onChange={e => setMainGross(e.target.value)} />
                    <div className="edit-hint">{tr.editable}</div>
                  </div>
                </> : <>
                  <div className="price-label">{tr.quote}</div>
                  <div className="price-value">{formatPrice(quote.main_product.gross_price, lang)}</div>
                  <div className="price-unit">{tr.exclVat}</div>
                </>}
              </div>
            </div>

            {(hardware.length > 0 || software.length > 0 || subscriptions.length > 0) && <div className="sub-items">
              {hardware.length > 0 && <><div className="sub-section-label">{tr.accessories}</div>{hardware.map((item, idx) => <div className="sub-item" key={idx}><div><div className="item-name">{item.name}</div>{item.description && <div className="item-desc">{item.description}</div>}</div><div className="item-qty">{item.qty || 1} stk.</div>{isDealer ? <div className="item-price-stack"><div className="netto-small">Netto: {formatPrice(item.net_price, lang)}</div><input className="line-edit" value={lineGross[idx] || ''} onChange={e => { const n=[...lineGross]; n[idx]=e.target.value; setLineGross(n) }} /></div> : <div className="item-price">{formatPrice(item.gross_price, lang)}</div>}</div>)}</>}
              {software.length > 0 && <><div className="sub-section-label">{tr.software}</div>{software.map((item, idx) => <div className="sub-item" key={idx}><div><div className="item-name">{item.name}</div></div><div className="item-qty">1 lic.</div>{isDealer ? <div className="item-price-stack"><div className="netto-small">Netto: {formatPrice(item.net_price, lang)}</div><input className="line-edit" value={lineGross[hardware.length+idx] || ''} onChange={e => { const n=[...lineGross]; n[hardware.length+idx]=e.target.value; setLineGross(n) }} /></div> : <div className="item-price">{formatPrice(item.gross_price, lang)}</div>}</div>)}</>}
              {subscriptions.length > 0 && <><div className="sub-section-label">{tr.subscriptions}</div>{subscriptions.map((item, idx) => <div className="sub-item" key={idx}><div><div className="item-name">{item.name}</div>{item.description && <div className="item-desc">{item.description}</div>}</div><div className="item-qty"><span className={`sub-badge ${item.badge || 'monthly'}`}>{item.badge === 'yearly' ? tr.yearly : tr.monthly}</span></div><div className="item-price">{formatPrice(item.gross_price, lang)}{item.badge === 'yearly' ? tr.perYear : tr.perMonth}</div></div>)}</>}
            </div>}
          </div>
        </>}

        {accessories.length > 0 && <div className="acc-section no-print">
          <div className="section-title">{tr.accessories}</div>
          <div className="acc-grid">
            {accessories.map((acc, idx) => {
              const selected = !!selectedAccessories.find(a => a.sku === acc.sku)
              const name = typeof acc.name === 'object' ? (acc.name[lang] || acc.name.da) : acc.name
              return <div key={idx} className={`acc-card ${selected ? 'selected' : ''}`} onClick={() => toggleAccessory(acc)}>
                <div className="acc-check">{selected && '✓'}</div>
                <div><div className="acc-name">{name}</div><div className="acc-price">{formatPrice(acc.gross_price, lang)}{acc.badge === 'yearly' ? tr.perYear : acc.badge === 'monthly' ? tr.perMonth : ''}</div></div>
              </div>
            })}
          </div>
        </div>}

        {totalGrossOneTime > 0 && <div className="leasing-block">
          <div className="leasing-title">{tr.leasingTitle}</div>
          <div className="leasing-amount">{formatPrice(leasing.monthlyPayment, lang)}<span style={{fontSize:16,color:'var(--ink-muted)'}}>{tr.perMonth}</span></div>
          <div className="leasing-sub">{leasing.termMonths} {tr.leasingMonths} · {lang === 'da' ? 'Restværdi' : lang === 'no' ? 'Restverdi' : 'Leifvirði'}: {formatPrice(leasing.residualValue, lang)}</div>
          <div className="leasing-disclaimer">{leasing.disclaimer[lang]}</div>
        </div>}

        <div className={`totals-block ${isDealer ? 'dealer' : 'customer'}`}>
          <div className="totals-grid">
            <div className="t-label">{tr.subtotal}</div>
            <div className="t-value">{formatPrice(totalGrossOneTime, lang)}</div>
            {!isDealer && <><div className="t-label">{tr.vat}</div><div className="t-value">{formatPrice(calcVat(totalGrossOneTime, lang), lang)}</div></>}
            <hr className="t-divider" />
            <div className="t-label main">{isDealer ? tr.total : tr.totalInclVat}</div>
            <div className="t-value main">{formatPrice(isDealer ? totalGrossOneTime : addVat(totalGrossOneTime, lang), lang)}</div>
          </div>
          <div className="totals-note">{isDealer ? `${tr.allPricesExcl} · ${tr.netPricesNote}` : tr.paymentTerms}</div>
        </div>

        {isDealer && <div className="dealer-tools no-print">
          <h3>{tr.forwardTitle}</h3>
          <p>{tr.forwardDesc}</p>
          <div className="tools-row">
            <button className="btn btn-primary" onClick={() => window.print()}>🖨 {tr.printCopy}</button>
            <button className="btn btn-secondary" onClick={() => { navigator.clipboard.writeText(window.location.origin + '/quote/' + quote.token + '?view=customer'); alert('Link kopieret!') }}>🔗 {tr.copyLink}</button>
          </div>
        </div>}

        {!isDealer && <div className="customer-action no-print">
          <p>{tr.contactText} <strong>{quote.sender_name || quote.dealer_name || 'CEPELO'}</strong> · {quote.sender_email}</p>
          <button className="accept-btn" onClick={handleAccept}>✓ {tr.acceptQuote}</button>
        </div>}

        {quote.notes && <div className="notes-block">
          <div className="notes-label">{tr.sellerNote}</div>
          <p>{quote.notes}</p>
        </div>}

        <div className="quote-footer">
          <div className="footer-brand"><strong>{isDealer ? 'CEPELO A/S' : (quote.dealer_name || 'CEPELO A/S')}</strong> · salg@cepelo.dk</div>
          <div className="footer-contact">cepelo.dk</div>
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps({ params, query }) {
  const { createClient } = await import('@supabase/supabase-js')
  const adminClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )

  const { data: quote, error } = await adminClient
    .from('quotes')
    .select('*')
    .eq('token', params.token)
    .single()

  if (error) {
    console.error('[quote/getServerSideProps] Supabase error:', {
      token: params.token,
      message: error.message,
      code: error.code,
      status: error.status,
    })
    return { props: { quote: null } }
  }

  if (!quote) {
    console.error('[quote/getServerSideProps] No quote found for token:', params.token)
    return { props: { quote: null } }
  }

  if (query.view === 'customer') quote.type = 'customer'
  return { props: { quote } }
}
