import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !key) {
    return res.status(500).json({ error: 'Missing env vars', url: !!url, key: !!key })
  }

  const supabase = createClient(url, key)
  const { count, error } = await supabase
    .from('quotes')
    .select('*', { count: 'exact', head: true })

  if (error) {
    return res.status(500).json({
      raw: JSON.parse(JSON.stringify(error, Object.getOwnPropertyNames(error))),
      supabaseUrl: url.slice(0, 30),
    })
  }

  return res.status(200).json({ count })
}
