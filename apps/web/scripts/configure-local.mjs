import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const root = new URL('../../../',import.meta.url)
const config = JSON.parse(execFileSync('npx',['--yes','supabase@2.117.0','status','-o','json'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}))
if (config.API_URL !== 'http://127.0.0.1:54321') throw new Error('Expected the disposable local Supabase stack only.')
writeFileSync(new URL('../.env.local',import.meta.url),`VITE_SUPABASE_URL=${config.API_URL}\nVITE_SUPABASE_PUBLISHABLE_KEY=${config.ANON_KEY}\n`)
console.log('Public browser configuration written for local Supabase. No production credentials used.')
