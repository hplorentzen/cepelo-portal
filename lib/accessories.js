export const accessories = {
  "_global": [
    { sku: "SVC-GOLD-1Y", type: "subscription", badge: "yearly",   name: { da: "Serviceaftale Guld", no: "Serviceavtale Gull", is: "Þjónustusamningur Gull" }, description: { da: "2× årlig service, reservedele inkl., prioriteret respons", no: "2× årlig service, reservedeler inkl.", is: "2× árleg þjónusta, varahlutir inkl." }, gross_price: 5500 },
    { sku: "SVC-SILVER-1Y", type: "subscription", badge: "yearly", name: { da: "Serviceaftale Sølv", no: "Serviceavtale Sølv", is: "Þjónustusamningur Silfur" }, description: { da: "1× årlig service, arbejdsløn inkl.", no: "1× årlig service, arbeidslønn inkl.", is: "1× árleg þjónusta, vinnulaun inkl." }, gross_price: 3200 },
    { sku: "LC-SUB-MD", type: "subscription", badge: "monthly",    name: { da: "LiftConnect — Vedligeholdsabonnement", no: "LiftConnect — Vedlikeholdsabonnement", is: "LiftConnect — Viðhaldsáskrift" }, description: { da: "Remote diagnostik, opdateringer og 24/7 support", no: "Fjerndiagnostikk, oppdateringer og 24/7 support", is: "Fjargreining, uppfærslur og 24/7 stuðningur" }, gross_price: 295 },
  ]
}

export function getAccessoriesForSku(sku) {
  const specific = accessories[sku] || []
  const global = accessories['_global'] || []
  return [...specific, ...global]
}
