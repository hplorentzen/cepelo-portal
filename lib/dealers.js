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
const DEALERS = {
  'ftz.dk': {
    shortName: 'FTZ',
    logoUrl:   'https://www.ftz.dk/skin/images/ftz-logo.png',
  },
  'au2parts.dk': {
    shortName: 'au2parts',
    logoUrl:   'https://www.au2parts.dk/logo.png',
  },
  'addanmark.dk': {
    shortName: 'AD Danmark',
    logoUrl:   'https://www.addanmark.dk/logo.png',
  },
  'wm-autodele.dk': {
    shortName: 'WM Autodele',
    logoUrl:   'https://www.wm-autodele.dk/logo.png',
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

  // Unknown company domain: no shortName; try Brandfetch CDN as logo
  return {
    domain,
    shortName: null,
    logoUrl:   `https://cdn.brandfetch.io/${domain}/theme/light/logo`,
  }
}

export default DEALERS
