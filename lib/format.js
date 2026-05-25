export const formatPrice = (amount, lang = 'da', suffix = '') => {
  if (!amount && amount !== 0) return '—'
  const num = typeof amount === 'string'
    ? parseFloat(amount.replace(/[^\d.,]/g, '').replace(',', '.'))
    : amount
  if (isNaN(num)) return amount
  const locale = lang === 'is' ? 'is-IS' : lang === 'no' ? 'nb-NO' : 'da-DK'
  const formatted = new Intl.NumberFormat(locale, { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(num)
  const currency = lang === 'is' ? 'kr.' : 'kr'
  return `${formatted} ${currency}${suffix ? ' ' + suffix : ''}`
}

export const vatRate = { da: 0.25, no: 0.25, is: 0.24 }
export const addVat = (amount, lang = 'da') => Math.round(amount * (1 + vatRate[lang]))
export const calcVat = (amount, lang = 'da') => Math.round(amount * vatRate[lang])
export const parsePrice = (str) => {
  if (!str && str !== 0) return 0
  const s = String(str).replace(/[^\d.,]/g, '').trim()
  if (!s) return 0
  // "11.995,00" or "11.995" — Danish: dot = thousands sep, comma = decimal
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) {
    return parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0
  }
  // "11,995.00" — English: comma = thousands sep, dot = decimal
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) {
    return parseFloat(s.replace(/,/g, '')) || 0
  }
  // "150,00" — bare decimal comma
  if (/,\d{1,2}$/.test(s)) {
    return parseFloat(s.replace(',', '.')) || 0
  }
  return parseFloat(s) || 0
}
