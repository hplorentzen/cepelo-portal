// lib/dealers.js
// Known dealer domains → short display name + logo URL.
//
// getDealerInfo(email) returns { domain, shortName, logoUrl } for any company
// email address. For domains not in the table, logoUrl falls back to the
// Brandfetch CDN (image may or may not load; always guard with onError in UI).
//
// Add new dealers here — no other files need changing.

// Consumer/webmail domains that should never get a logo lookup
const CONSUMER_DOMAINS = new Set([
  'gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com',
  'icloud.com', 'live.com', 'me.com', 'msn.com',
])

// Known dealers: domain → { shortName, logoUrl }
// Logo URLs verified 2026-06-01 — update if a dealer redesigns their site.
const DEALERS = {
  'ftz.dk': {
    shortName: 'FTZ',
    logoUrl:   'https://www.ftz.dk/wp-content/uploads/FTZ_Logo.svg',
  },
  'au2parts.dk': {
    shortName: 'au2parts',
    logoUrl:   'https://au2parts.dk/assets/au2parts_logo.svg',
  },
  'addanmark.dk': {
    shortName: 'AD Danmark',
    logoUrl:   'https://www.addanmark.dk/wp-content/uploads/2018/12/ad-danmark-logo.png',
  },
  'wm-autodele.dk': {
    shortName: 'WM Autodele',
    logoUrl:   'https://a.storyblok.com/f/283619/1251x850/7d7d431324/wm_fahrzeugteile_daenemark_logo_4c.png',
  },
}

/**
 * Resolve dealer branding from an email address.
 *
 * @param {string} email  – e.g. "john@ftz.dk"
 * @returns {{ domain: string, shortName: string|null, logoUrl: string|null } | null}
 *   Returns null for consumer domains or when email is empty.
 */
export function getDealerInfo(email) {
  if (!email) return null
  const domain = email.split('@')[1]?.toLowerCase().trim()
  if (!domain || CONSUMER_DOMAINS.has(domain)) return null

  const known = DEALERS[domain]
  if (known) return { domain, ...known }

  // Unknown company domain: no shortName, no logo.
  // Brandfetch blocks hotlinking without an API key (redirects to their docs page),
  // so we skip it and show no logo rather than displaying stray text.
  return {
    domain,
    shortName: null,
    logoUrl:   null,
  }
}

export default DEALERS
