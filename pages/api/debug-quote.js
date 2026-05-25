import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  const { token } = req.query
  if (!token) return res.status(400).json({ error: 'Pass ?token=...' })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  const results = {}

  // Try with anon key
  if (url && anonKey) {
    const anon = createClient(url, anonKey)
    const r = await anon.from('quotes').select('token, status').eq('token', token).single()
    results.anon = { status: r.status, error: r.error, found: !!r.data }
  } else {
    results.anon = 'env vars missing'
  }

  // Try with service role key
  if (url && serviceKey) {
    const admin = createClient(url, serviceKey)
    const r = await admin.from('quotes').select('token, status').eq('token', token).single()
    results.service = { status: r.status, error: r.error, found: !!r.data }
  } else {
    results.service = 'env vars missing'
  }

  return res.status(200).json({
    token,
    supabaseUrl: url?.slice(0, 40),
    anonKeySet: !!anonKey,
    serviceKeySet: !!serviceKey,
    results,
  })
}
