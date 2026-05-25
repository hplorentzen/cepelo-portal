import { createClient } from '@supabase/supabase-js'

// Lazy singleton — deferred until first call so a missing/invalid URL
// during Next.js build-time static analysis never crashes the module.
let _client = null
export const supabase = new Proxy({}, {
  get(_, prop) {
    if (!_client) {
      _client = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      )
    }
    const val = _client[prop]
    return typeof val === 'function' ? val.bind(_client) : val
  },
})
