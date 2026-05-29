// pages/api/shopify-oauth/callback.js
//
// Step 2 of the one-time OAuth flow. Shopify redirects here after the
// merchant authorises the app. This endpoint:
//   1. Validates the HMAC signature (proves the request came from Shopify)
//   2. Verifies the state/nonce (CSRF protection)
//   3. POSTs code → Shopify to exchange for a permanent offline access token
//   4. Displays the token so you can copy it into Vercel as SHOPIFY_ADMIN_TOKEN
//
// This endpoint has no side effects beyond displaying the token — it does NOT
// write to Supabase or modify any Vercel env vars automatically.

import { createHmac } from 'crypto'

const CLIENT_ID = '3233329f094b6f73715e5447b32ca3f2'

/** Validate Shopify's HMAC signature on the callback query string. */
function isValidHmac(query, clientSecret) {
  const { hmac, ...rest } = query
  if (!hmac) return false
  const message = Object.keys(rest)
    .sort()
    .map(k => `${k}=${rest[k]}`)
    .join('&')
  const computed = createHmac('sha256', clientSecret).update(message).digest('hex')
  // Constant-time comparison to prevent timing attacks
  if (computed.length !== hmac.length) return false
  let diff = 0
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ hmac.charCodeAt(i)
  }
  return diff === 0
}

/** Read a cookie value from the request headers. */
function getCookie(req, name) {
  const raw = req.headers.cookie || ''
  const pair = raw.split(';').map(c => c.trim()).find(c => c.startsWith(`${name}=`))
  return pair ? pair.slice(name.length + 1) : null
}

export default async function handler(req, res) {
  const { code, state, shop, hmac } = req.query
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET

  // ── Basic param checks ────────────────────────────────────────────────────
  if (!code || !state || !shop) {
    return res.status(400).send(errorPage('Missing required parameters (code, state, shop).'))
  }
  if (!clientSecret) {
    return res.status(500).send(errorPage('SHOPIFY_CLIENT_SECRET not set in Vercel env vars.'))
  }

  // ── HMAC validation ───────────────────────────────────────────────────────
  if (!isValidHmac(req.query, clientSecret)) {
    return res.status(400).send(errorPage('HMAC validation failed — request may not be from Shopify.'))
  }

  // ── CSRF / nonce check ────────────────────────────────────────────────────
  const storedState = getCookie(req, 'shopify_oauth_state')
  if (!storedState || storedState !== state) {
    return res.status(400).send(errorPage(
      'State mismatch — possible CSRF attack, or the 5-minute nonce window expired. ' +
      'Please restart from /api/shopify-oauth/start.'
    ))
  }

  // ── Exchange authorization code for access token ──────────────────────────
  let tokenData
  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body:    new URLSearchParams({ client_id: CLIENT_ID, client_secret: clientSecret, code }),
    })
    tokenData = await tokenRes.json()
    if (!tokenRes.ok) throw new Error(JSON.stringify(tokenData))
  } catch (e) {
    return res.status(500).send(errorPage(`Token exchange failed: ${e.message}`))
  }

  const { access_token, scope } = tokenData

  if (!access_token) {
    return res.status(500).send(errorPage(
      `Shopify did not return an access_token. Response: ${JSON.stringify(tokenData)}`
    ))
  }

  // Clear the nonce cookie
  res.setHeader('Set-Cookie', 'shopify_oauth_state=; Path=/; HttpOnly; Secure; Max-Age=0')

  // ── Display the token ─────────────────────────────────────────────────────
  return res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Shopify OAuth ✅ Success</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 700px; margin: 60px auto; padding: 0 20px; color: #111; }
    h1   { color: #1a7f37; }
    pre  { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 16px;
           font-size: 13px; word-break: break-all; white-space: pre-wrap; user-select: all; }
    .steps { background: #fff8c5; border: 1px solid #d4a72c; border-radius: 6px; padding: 16px; }
    .steps ol { margin: 8px 0 0; padding-left: 20px; }
    .steps li { margin: 6px 0; }
    .label { font-weight: 600; color: #555; font-size: 13px; margin-bottom: 4px; }
    .warn  { color: #cf222e; font-size: 13px; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>✅ OAuth successful</h1>
  <p>You now have a permanent offline access token for <strong>${shop}</strong>.</p>

  <div class="label">Token (click to select all, then copy):</div>
  <pre id="token">${access_token}</pre>
  <p class="warn">⚠️ This token is displayed once. Copy it now — you cannot retrieve it again without re-running OAuth.</p>

  <p><strong>Scope granted:</strong> ${scope}</p>

  <div class="steps">
    <strong>Next steps — store the token in Vercel:</strong>
    <ol>
      <li>Copy the token above</li>
      <li>Open <a href="https://vercel.com" target="_blank">vercel.com</a> → your project → <strong>Settings → Environment Variables</strong></li>
      <li>Find <code>SHOPIFY_ADMIN_TOKEN</code> → click Edit → paste the token → Save</li>
      <li>Go to <strong>Deployments</strong> → click the three-dot menu on the latest deployment → <strong>Redeploy</strong></li>
      <li>Test with: <code>GET /api/debug-shopify</code> — should return <code>httpStatus: 200</code></li>
    </ol>
  </div>
</body>
</html>`)
}

function errorPage(msg) {
  return `<!DOCTYPE html>
<html><head><title>OAuth Error</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:60px auto;padding:0 20px">
  <h1 style="color:#cf222e">❌ OAuth Error</h1>
  <p>${msg}</p>
  <p><a href="/api/shopify-oauth/start">← Try again</a></p>
</body></html>`
}
