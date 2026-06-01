// lib/sellers.js
// CEPELO A/S sales team directory — sourced from cepelo.dk/pages/contact
//
// To add or override an entry without editing this file, use sellers-override.js.
//
// Usage:
//   import { getSellerByEmail } from '../lib/sellers'
//   const seller = getSellerByEmail('bc@cepelo.dk')
//   // → { name: 'Brian Corydon', title: 'Account Manager – Auto', email: 'bc@cepelo.dk', phone: '+45 26 43 45 34', photo: null }

import { sellersOverride } from './sellers-override.js'

const SELLERS = [
  {
    name:  'Brian Corydon',
    title: 'Account Manager – Auto',
    email: 'bc@cepelo.dk',
    phone: '+45 26 43 45 34',
    photo: null,
  },
  {
    name:  'Henrik Tvekjær Mogensen',
    title: 'Account Manager – Auto',
    email: 'htm@cepelo.dk',
    phone: '+45 60 14 79 67',
    photo: null,
  },
  {
    name:  'Arnar Hrafn Snorrason',
    title: 'Account Manager – Retail',
    email: 'ahs@cepelo.dk',
    phone: '+45 28 59 63 84',
    photo: null,
  },
  {
    name:  'Leif Brøgger Andreasen',
    title: 'Operations Manager',
    email: 'lba@cepelo.dk',
    phone: '+45 28 89 51 07',
    photo: null,
  },
  {
    name:  'Thomas Ørts Tjell',
    title: 'Technical Supporter',
    email: 'tt@cepelo.dk',
    phone: '+45 98 18 02 03',
    photo: null,
  },
  {
    name:  'Tobias Alexander Hansen',
    title: 'Technical Supporter',
    email: 'tah@cepelo.dk',
    phone: '+45 98 18 02 03',
    photo: null,
  },
  {
    name:  'Amalie Thomsen',
    title: 'Sales Supporter',
    email: 'at@cepelo.dk',
    phone: '+45 96 32 10 44',
    photo: null,
  },
  {
    name:  'Mads Rasmussen',
    title: 'Sales Supporter',
    email: 'mr@cepelo.dk',
    phone: '+45 28 59 56 74',
    photo: null,
  },
]

// Build a normalised map from the static array (lowercase email → record)
const sellers = Object.fromEntries(
  SELLERS.map(s => [s.email.toLowerCase(), s])
)

/**
 * Look up a seller by email address (case-insensitive).
 * sellers-override.js is checked first so entries can be added or corrected
 * without touching this file. Falls back to the static SELLERS list.
 * Returns null if the email is not found in either source.
 *
 * @param {string} email
 * @returns {{ name: string, title: string, email: string, phone: string, photo: string|null } | null}
 */
export function getSellerByEmail(email) {
  const normalised = email?.toLowerCase().trim()
  if (!normalised) return null
  return sellersOverride[normalised] || sellers[normalised] || null
}

export default SELLERS
