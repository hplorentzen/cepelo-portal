import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !key) {
    return res.status(500).json({ error: 'Missing env vars', url: !!url, key: !!key })
  }

  const supabase = createClient(url, key)
  const response = await supabase
    .from('quotes')
    .select('*', { count: 'exact', head: true })

  return res.status(200).json({
    count: response.count,
    status: response.status,
    statusText: response.statusText,
    error: response.error
      ? JSON.parse(JSON.stringify(response.error, Object.getOwnPropertyNames(response.error)))
      : null,
  })
}
