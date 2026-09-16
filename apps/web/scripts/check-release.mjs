import { loadEnv } from 'vite'
const env=loadEnv('production',process.cwd(),'VITE_')
const url=process.env.VITE_SUPABASE_URL || env.VITE_SUPABASE_URL
const key=process.env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY
if(!url || !key) throw new Error('Configure production Supabase public values before creating a release.')
let origin
try { origin=new URL(url) } catch { throw new Error('Configure a valid production Supabase URL.') }
const host=origin.hostname.replace(/^\[|\]$/g,'')
if(origin.protocol!=='https:' || ['localhost','0.0.0.0','::1'].includes(host) || host.endsWith('.localhost') || /^127\./.test(host)) throw new Error('A release must use the production HTTPS Supabase project, never the local test backend.')
if(origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash) throw new Error('Use the Supabase project origin without credentials, paths, queries, or fragments.')
if(key.startsWith('sb_secret_')) throw new Error('A secret key must never be embedded in the website.')
if(key.startsWith('eyJ')) {
  let claims
  try { if(key.split('.').length!==3) throw new Error(); claims=JSON.parse(Buffer.from(key.split('.')[1],'base64url')) } catch { throw new Error('Configure a valid anon or publishable Supabase key.') }
  if(claims?.role!=='anon') throw new Error('Only an anon or publishable Supabase key may be embedded in the website.')
} else if(!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) throw new Error('Configure a valid anon or publishable Supabase key.')
console.log('Production public configuration is present. Complete the documented release acceptance checks before publishing.')
