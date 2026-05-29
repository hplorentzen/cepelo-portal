// pages/api/shopify-oauth/start.js
//
// Step 1 of the one-time OAuth flow to obtain a permanent offline
// SHOPIFY_ADMIN_TOKEN for the CEPELO Partner App.
//
// Visit once (as an admin) — it redirects to Shopify for authorization,
// then Shopify redirects back to /api/shopify-oauth/callback where the
// token is displayed for you to copy into Vercel env vars.
//
// Usage:
//   https://cepelo-portal.vercel.app/api/shopify-oauth/start?key=<CEPELO_API_SECRET>
//
// Before visiting, ensure the callback URL is registered in your app's
// "Allowed redirect URLs" in the Shopify Partner Dashboard:
//   https://cepelo-portal.vercel.app/api/shopify-oauth/callback
//
// Required Vercel env vars (set these before deploying):
//   SHOPIFY_CLIENT_SECRET  = shpss_...   (Partner App client secret)
//   CEPELO_API_SECRET                    (already set — used as admin gate)

import { randomBytes } from 'crypto'

const SHOP        = 'cepelotools.myshopify.com'
const CLIENT_ID   = '3233329f094b6f73715e5447b32ca3f2'  // Partner App client ID (not secret)
const SCOPES      = 'read_draft_orders'

export default function handler(req, res) {
  // Gate: only the CEPELO admin can trigger the OAuth flow
  if (req.query.key !== process.env.CEPELO_API_SECRET) {
    return res.status(401).send('Unauthorized — pass ?key=<CEPELO_API_SECRET>')
  }

  if (!process.env.SHOPIFY_CLIENT_SECRET) {
    return res.status(500).send(
      'SHOPIFY_CLIENT_SECRET is not set in Vercel env vars. ' +
      'Add the Partner App client secret (shpss_…) to Vercel before proceeding.'
    )
  }

  const baseUrl    = process.env.NEXT_PUBLIC_BASE_URL || 'https://cepelo-portal.vercel.app'
  const redirectUri = `${baseUrl}/api/shopify-oauth/callback`
  const state      = randomBytes(16).toString('hex')

  // Store nonce in a short-lived HttpOnly cookie for CSRF verification in callback
  res.setHeader(
    'Set-Cookie',
    `shopify_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`
  )

  const authUrl = new URL(`https://${SHOP}/admin/oauth/authorize`)
  authUrl.searchParams.set('client_id',    CLIENT_ID)
  authUrl.searchParams.set('scope',        SCOPES)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('state',        state)
  // Omitting grant_options[]=per-user → Shopify issues an OFFLINE (permanent) token

  res.redirect(302, authUrl.toString())
}
