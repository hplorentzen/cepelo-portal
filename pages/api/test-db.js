import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    return res.status(500).json({ error: 'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' })
  }

  const supabase = createClient(url, key)
  const { count, error } = await supabase
    .from('quotes')
    .select('*', { count: 'exact', head: true })

  if (error) return res.status(500).json({ error: error.message })

  return res.status(200).json({ count })
}
