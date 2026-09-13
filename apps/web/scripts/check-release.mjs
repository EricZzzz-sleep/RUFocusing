import { loadEnv } from 'vite'
const env=loadEnv('production',process.cwd(),'VITE_')
const url=process.env.VITE_SUPABASE_URL || env.VITE_SUPABASE_URL
const key=process.env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY
if(!url || !key) throw new Error('Configure production Supabase public values before creating a release.')
const origin=new URL(url)
if(origin.protocol!=='https:' || ['localhost','127.0.0.1','0.0.0.0','::1'].includes(origin.hostname)) throw new Error('A release must use the production HTTPS Supabase project, never the local test backend.')
if(key.startsWith('sb_secret_')) throw new Error('A secret key must never be embedded in the website.')
if(key.startsWith('eyJ')) { const claims=JSON.parse(Buffer.from(key.split('.')[1],'base64url')); if(claims.role!=='anon') throw new Error('Only an anon or publishable Supabase key may be embedded in the website.') }
console.log('Production public configuration is present. Complete the documented release acceptance checks before publishing.')
