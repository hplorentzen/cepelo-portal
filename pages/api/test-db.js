import { supabase } from '../../lib/supabase'

export default async function handler(req, res) {
  const { count, error } = await supabase
    .from('quotes')
    .select('*', { count: 'exact', head: true })

  if (error) return res.status(500).json({ error: error.message, details: error })

  return res.status(200).json({ count })
}
