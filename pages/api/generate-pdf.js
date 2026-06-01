// pages/api/generate-pdf.js
// VERSION: 2026-06-01
//
// Generates a customer-facing PDF quote (gross prices only, no net prices).
// Called by the dealer's Download PDF button.
//
// GET /api/generate-pdf?token=<dealer_token>
// Returns: application/pdf

import { createClient } from '@supabase/supabase-js'
import PDFDocument from 'pdfkit'
import path from 'path'
import fs from 'fs'

const adminClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ─── Diagnostic product detection (mirrors pages/quote/[token].js) ────────────
const DIAG_KEYWORDS = ['MS909','MS919','Ultra','IM508','IM608','Elite','909CV','MX900','DS900','906PRO','Autel']
function hasDiagKeyword(str) {
  if (!str) return false
  const s = str.toLowerCase()
  return s.includes('diagnos') || s.includes('autodiag') ||
    DIAG_KEYWORDS.some(k => s.includes(k.toLowerCase()))
}
function isAutodiagnose(quote) {
  if (quote.category === 'Autodiagnose') return true
  const all = [quote.main_product, ...(quote.line_items || [])].filter(Boolean)
  return all.some(p =>
    hasDiagKeyword(p.product_type) ||
    hasDiagKeyword(typeof p.name === 'object' ? (p.name?.da || p.name?.en || '') : (p.name || '')) ||
    hasDiagKeyword(p.sku)
  )
}

// ─── Formatting ───────────────────────────────────────────────────────────────
function fmtKr(n) {
  if (!n && n !== 0) return '-'
  return new Intl.NumberFormat('da-DK', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n) + ' kr'
}
function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('da-DK', { day: 'numeric', month: 'long', year: 'numeric' })
}
function getName(n) {
  if (!n) return ''
  return typeof n === 'object' ? (n.da || n.en || Object.values(n)[0] || '') : String(n)
}

// ─── Dealer logo map (PNG/JPG only – pdfkit does not support SVG) ─────────────
// FTZ uses an SVG logo; it will fall back to dealer name as text.
const LOGO_FILES = {
  'au2parts.dk':    'au2parts.png',
  'addanmark.dk':   'addanmark.png',
  'wm-autodele.dk': 'wm-autodele.png',
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { token } = req.query
  if (!token) return res.status(400).json({ error: 'token required' })

  // ── 1. Fetch quote ──────────────────────────────────────────────────────────
  const { data: quote, error } = await adminClient
    .from('quotes')
    .select('*')
    .eq('token', token)
    .single()

  if (error || !quote) {
    console.error('[generate-pdf] not found token=', token, error?.message)
    return res.status(404).json({ error: 'Quote not found' })
  }

  // ── 2. Build product lists ──────────────────────────────────────────────────
  const lineItems     = quote.line_items || []
  const productLines  = lineItems.filter(i =>
    !['accessory','software','subscription','manual','discount'].includes(i.type)
  )
  const manualItems   = lineItems.filter(i => i.type === 'manual')
  const discountItems = lineItems.filter(i => i.type === 'discount')
  const subscriptions = lineItems.filter(i => i.type === 'subscription')

  // Main product + regular line items, sorted by gross price descending
  const allProducts = [
    ...(quote.main_product ? [quote.main_product] : []),
    ...productLines,
  ].sort((a, b) => (b.gross_price || 0) - (a.gross_price || 0))

  // ── 3. Compute totals ───────────────────────────────────────────────────────
  const productGross = [...allProducts, ...manualItems].reduce((s, i) => {
    const p = i.gross_price || i.net_price || 0
    return s + p * (i.quantity || 1)
  }, 0)
  const discountTotal = discountItems.reduce((s, i) =>
    s + Math.abs(i.gross_price || i.net_price || 0), 0)
  const subtotal = Math.round(productGross - discountTotal)
  const vat      = Math.round(subtotal * 0.25)
  const total    = subtotal + vat

  // ── 4. Dealer branding ──────────────────────────────────────────────────────
  const dealerEmail  = (quote.dealer_email || '').toLowerCase()
  const dealerDomain = dealerEmail.split('@')[1]?.trim() || ''
  const quoteRef     = (quote.token || '').slice(-6).toUpperCase()
  const shopifyRef   = quote.shopify_order_id && quote.shopify_order_id !== 'PARSED'
    ? quote.shopify_order_id : null

  let logoBuffer = null
  if (LOGO_FILES[dealerDomain]) {
    try {
      logoBuffer = fs.readFileSync(path.join(process.cwd(), 'public', LOGO_FILES[dealerDomain]))
    } catch { /* logo file missing — fall back to text */ }
  }

  // ── 5. Create PDF document ──────────────────────────────────────────────────
  const LM = 52   // left margin
  const RM = 52   // right margin
  const TM = 50   // top margin
  const BM = 50   // bottom margin

  const doc = new PDFDocument({
    size:    'A4',
    margins: { top: TM, bottom: BM, left: LM, right: RM },
    info: {
      Title:   `Tilbud #${quoteRef}`,
      Author:  quote.dealer_name || 'CEPELO',
      Subject: 'Tilbud',
      Creator: 'CEPELO Portal',
    },
    bufferPages: true,
  })

  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="tilbud-${quoteRef}.pdf"`)
  doc.pipe(res)

  const PW = doc.page.width   // 595.28
  const PH = doc.page.height  // 841.89
  const CW = PW - LM - RM    // 491.28

  // ── Color constants ─────────────────────────────────────────────────────────
  const NAVY    = '#173454'
  const BLUE    = '#0868B2'
  const MUTED   = '#767686'
  const BORDER  = '#E0E0E4'
  const INK     = '#323232'
  const GREEN   = '#2e7d32'
  const ROW_DIV = '#F0F0F2'
  const INFO_BG = '#E0F0FA'

  // ── Drawing helpers ─────────────────────────────────────────────────────────

  // Thin horizontal rule
  function rule(y, color = BORDER, weight = 0.5) {
    doc.save()
    doc.moveTo(LM, y).lineTo(LM + CW, y)
       .strokeColor(color).lineWidth(weight).stroke()
    doc.restore()
  }

  // Small-caps section label; returns y after label
  function sectionLabel(text, y) {
    doc.save()
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED)
       .text(text, LM, y, { width: CW, lineBreak: false, characterSpacing: 0.8 })
    doc.restore()
    return y + 14
  }

  // Draw footer on current page at fixed bottom position
  function drawFooter() {
    const fy = PH - BM + 12
    rule(fy - 8, BORDER, 0.5)
    doc.save()
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
       .text(
         'Vi sikrer fremtidens værksted  •  CEPELO A/S  •  Nibevej 54, 9200 Aalborg SV  •  +45 98 18 09 00  •  cepelo.dk',
         LM, fy, { width: CW, align: 'center', lineBreak: false }
       )
    doc.restore()
  }

  // Safe page break: if y + neededHeight would overflow, add page and return new y
  function maybeBreak(y, needed = 40) {
    if (y + needed > PH - BM - 30) {
      drawFooter()
      doc.addPage()
      return TM
    }
    return y
  }

  // ── PAGE 1: HEADER ──────────────────────────────────────────────────────────
  let y = TM

  // Dealer logo (left) — PNG only; SVG falls back to dealer name text
  if (logoBuffer) {
    doc.image(logoBuffer, LM, y, { height: 38, fit: [170, 38] })
  } else {
    doc.font('Helvetica-Bold').fontSize(15).fillColor(NAVY)
       .text(quote.dealer_name || dealerDomain || '', LM, y + 10, { lineBreak: false })
  }

  // Quote ref + date (right-aligned)
  doc.font('Helvetica-Bold').fontSize(21).fillColor(NAVY)
     .text(`#${quoteRef}`, LM, y, { width: CW, align: 'right', lineBreak: false })

  if (shopifyRef) {
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
       .text(`Shopify ${shopifyRef}`, LM, y + 28, { width: CW, align: 'right', lineBreak: false })
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
       .text(fmtDate(quote.created_at || new Date().toISOString()), LM, y + 40, { width: CW, align: 'right', lineBreak: false })
  } else {
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
       .text(fmtDate(quote.created_at || new Date().toISOString()), LM, y + 28, { width: CW, align: 'right', lineBreak: false })
  }

  y += 60
  rule(y, BORDER, 1)
  y += 22

  // ── CUSTOMER SECTION ────────────────────────────────────────────────────────
  y = sectionLabel('TILBUDDET ER UDSTEDT TIL', y)

  const recipientDisplay = quote.recipient_company || quote.recipient_name || '—'
  doc.font('Helvetica-Bold').fontSize(14).fillColor(NAVY)
     .text(recipientDisplay, LM, y, { lineBreak: false })
  y += 20

  if (quote.recipient_name && quote.recipient_name !== quote.recipient_company) {
    doc.font('Helvetica').fontSize(10.5).fillColor(INK)
       .text(quote.recipient_name, LM, y, { lineBreak: false })
    y += 14
  }
  if (quote.recipient_email) {
    doc.font('Helvetica').fontSize(10.5).fillColor(INK)
       .text(quote.recipient_email, LM, y, { lineBreak: false })
    y += 14
  }
  if (quote.recipient_phone) {
    doc.font('Helvetica').fontSize(10.5).fillColor(INK)
       .text(quote.recipient_phone, LM, y, { lineBreak: false })
    y += 14
  }

  // Notes block
  if (quote.notes && quote.notes.trim()) {
    y += 8
    rule(y, BORDER, 0.5)
    y += 12
    y = sectionLabel('BEMARK', y)  // Bemærk — ASCII safe label

    const noteH = doc.heightOfString(quote.notes.trim(), {
      width: CW, font: 'Helvetica', fontSize: 10,
    })
    doc.font('Helvetica').fontSize(10).fillColor(INK)
       .text(quote.notes.trim(), LM, y, { width: CW })
    y += noteH + 10
  }

  y += 14
  rule(y, BORDER, 1)
  y += 22

  // ── PRODUCTS TABLE ──────────────────────────────────────────────────────────
  y = sectionLabel('PRODUKTER', y)

  const QTY_X   = LM + CW - 195  // quantity column x
  const PRICE_X = LM + CW - 125  // price column x
  const PRICE_W = 125             // price column width
  const DESC_W  = QTY_X - LM - 8 // description max width

  // Table column headers
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED)
  doc.text('Beskrivelse',       LM,      y, { lineBreak: false })
  doc.text('Antal',             QTY_X,   y, { width: 60, align: 'center', lineBreak: false })
  doc.text('Pris ekskl. moms', PRICE_X, y, { width: PRICE_W, align: 'right', lineBreak: false })
  y += 10
  rule(y, BORDER, 0.5)
  y += 10

  // Draw one product row; returns new y
  function drawProductRow(item, subLabel = null) {
    const name  = getName(item.name) || item.sku || ''
    const qty   = item.quantity || 1
    const price = Math.round((item.gross_price || item.net_price || 0) * qty)

    // Measure name height at the description column width
    doc.font('Helvetica-Bold').fontSize(11)
    const nameH = doc.heightOfString(name, { width: DESC_W })
    const rowH  = Math.max(nameH, 18)

    // Page break if needed
    y = maybeBreak(y, rowH + 14)

    // Product name (left)
    doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY)
       .text(name, LM, y, { width: DESC_W })

    // Sub-label below name (e.g., SKU)
    if (subLabel) {
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
         .text(subLabel, LM, y + nameH, { width: DESC_W, lineBreak: false })
    }

    // Quantity (centre)
    doc.font('Helvetica').fontSize(11).fillColor(INK)
       .text(String(qty), QTY_X, y, { width: 60, align: 'center', lineBreak: false })

    // Price (right)
    if (price > 0) {
      doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY)
         .text(fmtKr(price), PRICE_X, y, { width: PRICE_W, align: 'right', lineBreak: false })
    }

    y += rowH + 10
    rule(y - 4, ROW_DIV, 0.4)

    return y
  }

  // Draw all main products
  allProducts.forEach(item => drawProductRow(item))

  // ── Manual items (montage, fragt, etc.) ─────────────────────────────────────
  if (manualItems.length > 0) {
    y += 10
    y = maybeBreak(y, 40)
    y = sectionLabel('ØVRIGE POSTER', y)  // Øvrige poster
    manualItems.forEach(item => drawProductRow(item))
  }

  // ── Discount lines ──────────────────────────────────────────────────────────
  if (discountItems.length > 0) {
    discountItems.forEach(item => {
      const amount = Math.abs(item.gross_price || item.net_price || 0)
      const label  = `Rabat – ${getName(item.name)}`
      y = maybeBreak(y, 28)

      doc.font('Helvetica-Bold').fontSize(11).fillColor(GREEN)
         .text(label, LM, y, { width: DESC_W, lineBreak: false })
      doc.font('Helvetica-Bold').fontSize(11).fillColor(GREEN)
         .text(`−${fmtKr(amount)}`, PRICE_X, y, { width: PRICE_W, align: 'right', lineBreak: false })
      y += 22
      rule(y - 4, ROW_DIV, 0.4)
    })
  }

  // ── Subscriptions ───────────────────────────────────────────────────────────
  if (subscriptions.length > 0) {
    y += 10
    y = maybeBreak(y, 40)
    y = sectionLabel('SOFTWAREOPDATERINGER', y)

    subscriptions.forEach(item => {
      const name  = getName(item.name)
      const price = item.gross_price || 0
      const badge = item.badge === 'yearly' ? '/år' : '/mdr'
      y = maybeBreak(y, 28)

      doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY)
         .text(name, LM, y, { width: DESC_W, lineBreak: false })
      doc.font('Helvetica').fontSize(11).fillColor(INK)
         .text('1', QTY_X, y, { width: 60, align: 'center', lineBreak: false })
      if (price > 0) {
        doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY)
           .text(fmtKr(price) + badge, PRICE_X, y, { width: PRICE_W, align: 'right', lineBreak: false })
      }
      y += 22
      rule(y - 4, ROW_DIV, 0.4)
    })
  }

  // ── Diagnostic software info box ─────────────────────────────────────────────
  if (isAutodiagnose(quote)) {
    const infoText =
      'Prisen inkluderer 2 års softwareopdateringer og teknisk support. ' +
      'For MS909, MS919 og MS Ultra er SGW Secure Gateway adgang også ' +
      'inkluderet i de første 2 år.'

    doc.font('Helvetica').fontSize(9.5)
    const infoH = doc.heightOfString(infoText, { width: CW - 44 })
    const boxH  = infoH + 34  // padding top + bottom

    y += 14
    y = maybeBreak(y, boxH + 10)

    doc.rect(LM, y, CW, boxH).fill(INFO_BG)

    doc.font('Helvetica-Bold').fontSize(10).fillColor(NAVY)
       .text('Softwareopdateringer inkluderet', LM + 14, y + 11, { lineBreak: false })
    doc.font('Helvetica').fontSize(9.5).fillColor(NAVY)
       .text(infoText, LM + 14, y + 25, { width: CW - 28 })

    y += boxH + 14
  }

  // ── TOTALS ───────────────────────────────────────────────────────────────────
  y += 12
  y = maybeBreak(y, 110)
  rule(y, BORDER, 1)
  y += 18

  const TOT_LABEL_X = LM + CW - 280
  const TOT_VALUE_X = PRICE_X
  const TOT_VALUE_W = PRICE_W

  function totalsRow(label, amount, isBold = false) {
    y = maybeBreak(y, 24)
    doc.font(isBold ? 'Helvetica-Bold' : 'Helvetica')
       .fontSize(isBold ? 13 : 11.5)
       .fillColor(isBold ? NAVY : INK)
    doc.text(label,         TOT_LABEL_X, y, { width: 150, lineBreak: false })
    doc.text(fmtKr(amount), TOT_VALUE_X, y, { width: TOT_VALUE_W, align: 'right', lineBreak: false })
    y += isBold ? 22 : 17
  }

  totalsRow('Subtotal ekskl. moms', subtotal)
  totalsRow('Moms (25%)',            vat)

  y += 6
  rule(y, BORDER, 0.5)
  y += 10

  // Grand total — larger
  y = maybeBreak(y, 30)
  doc.font('Helvetica-Bold').fontSize(15).fillColor(NAVY)
  doc.text('Total inkl. moms', TOT_LABEL_X, y, { width: 150, lineBreak: false })
  doc.text(fmtKr(total),       TOT_VALUE_X, y, { width: TOT_VALUE_W, align: 'right', lineBreak: false })
  y += 34

  // ── DEALER CONTACT ──────────────────────────────────────────────────────────
  y = maybeBreak(y, 90)
  rule(y, BORDER, 1)
  y += 18
  y = sectionLabel('KONTAKT', y)

  // Two-column: dealer details left, sender details right (if different)
  const hasSender = quote.sender_name &&
    quote.sender_name !== quote.dealer_name

  if (quote.dealer_name) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY)
       .text(quote.dealer_name, LM, y, { lineBreak: false })
    y += 16
  }
  if (quote.dealer_email) {
    doc.font('Helvetica').fontSize(10).fillColor(INK)
       .text(quote.dealer_email, LM, y, { lineBreak: false })
    y += 13
  }
  if (quote.dealer_phone) {
    doc.font('Helvetica').fontSize(10).fillColor(INK)
       .text(quote.dealer_phone, LM, y, { lineBreak: false })
    y += 13
  }

  // Seller info (if we have it and it's distinct from the dealer)
  if (hasSender) {
    // Reset y to contact section start and draw on the right column
    const senderStartY = y - (quote.dealer_phone ? 42 : quote.dealer_email ? 29 : 16)
    const rightX = LM + CW / 2

    doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY)
       .text(quote.sender_name || '', rightX, senderStartY, { lineBreak: false })
    let sy = senderStartY + 16
    if (quote.sender_email) {
      doc.font('Helvetica').fontSize(10).fillColor(INK)
         .text(quote.sender_email, rightX, sy, { lineBreak: false })
      sy += 13
    }
    if (quote.sender_phone) {
      doc.font('Helvetica').fontSize(10).fillColor(INK)
         .text(quote.sender_phone, rightX, sy, { lineBreak: false })
    }
  }

  // ── Draw footer on first (and only, usually) page ───────────────────────────
  drawFooter()

  doc.end()
}
