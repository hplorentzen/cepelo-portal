export const LEASING_DEFAULTS = {
  monthlyRatePercent: 1.9,
  termMonths: 60,
  residualMonths: 1,
}

export function calcLeasing(priceExVat, options = {}) {
  const rate = (options.monthlyRatePercent ?? LEASING_DEFAULTS.monthlyRatePercent) / 100
  const term = options.termMonths ?? LEASING_DEFAULTS.termMonths
  const residualMonths = options.residualMonths ?? LEASING_DEFAULTS.residualMonths
  const monthlyPayment = Math.round(priceExVat * rate)
  const residualValue = Math.round(monthlyPayment * residualMonths)
  return {
    monthlyPayment, residualValue, termMonths: term, priceExVat,
    disclaimer: {
      da: 'Vejledende leasingydelse. Endelig pris er genstand for konkret beregning og kreditvurdering hos leasingselskabet.',
      no: 'Veiledende leasingytelse. Endelig pris er gjenstand for konkret beregning og kredittvurdering hos leasingselskapet.',
      is: 'Leiðbeinandi leasinggreiðsla. Lokaverð er háð nákvæmri útreikningi og lánshæfismati hjá leasing-fyrirtækinu.'
    }
  }
}
