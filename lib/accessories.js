export const accessories = {
  "ROT-SPOA10": [
    { sku: "ROT-ACC-LCK",  type: "accessory", name: { da: "Monteringssæt til lav loft (u. 3,5m)", no: "Monteringssett for lavt tak", is: "Uppsetningarsett fyrir lágt loft" }, gross_price: 1800 },
    { sku: "ROT-PAD-SET4", type: "accessory", name: { da: "Gummipuder sæt (4 stk.)", no: "Gummiputer sett (4 stk.)", is: "Gúmmíkuddar (4 stk.)" }, gross_price: 595 },
    { sku: "LC-PRO-1",     type: "software",  name: { da: "LiftConnect Pro — Licens", no: "LiftConnect Pro — Lisens", is: "LiftConnect Pro — Leyfi" }, gross_price: 3200 },
  ],
  "ADAS-CAL-200": [
    { sku: "ADAS-TARGET-A", type: "accessory", name: { da: "Kalibreringstargetsæt A", no: "Kalibreringstargetssett A", is: "Kvörðunarmarkmið A" }, gross_price: 4500 },
    { sku: "ADAS-SW-1",     type: "software",  name: { da: "ADAS Manager Software", no: "ADAS Manager Programvare", is: "ADAS Manager hugbúnaður" }, gross_price: 2800 },
  ],
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
