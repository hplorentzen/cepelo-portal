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
  if (!str) return 0
  return parseFloat(String(str).replace(/[^\d.,]/g, '').replace(',', '.')) || 0
}
