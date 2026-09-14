import { createClient } from '@supabase/supabase-js'
import { studyReport, withReport, validateReflection, validateAnnotations, type CloudSession } from '../_shared/study.ts'

const allowed = new Set((Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map(s => s.trim()).filter(Boolean))
const url = Deno.env.get('SUPABASE_URL')!
const key = Deno.env.get('SUPABASE_ANON_KEY')!
const json = (body: unknown, status = 200, origin = '') => new Response(JSON.stringify(body), { status, headers: {
  'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  ...(allowed.has(origin) ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {}),
} })
Deno.serve(async req => {
  const origin = req.headers.get('origin') ?? ''
  if (origin && !allowed.has(origin)) return json({ error: 'Origin not allowed.' }, 403)
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info', 'Access-Control-Max-Age': '600', 'Vary': 'Origin' } })
  const requestId = crypto.randomUUID()
  try {
    const token = req.headers.get('Authorization')
    if (!token?.startsWith('Bearer ')) return json({ error: 'Sign in required.' }, 401, origin)
    const client = createClient(url, key, { global: { headers: { Authorization: token } }, auth: { persistSession: false, autoRefreshToken: false } })
    const { data: { user }, error: authError } = await client.auth.getUser(token.slice(7))
    if (authError || !user) return json({ error: 'Your sign-in expired. Sign in again.' }, 401, origin)
    const path = new URL(req.url).pathname.replace(/^.*\/api(?=\/|$)/, '') || '/'
    const query = new URL(req.url).searchParams
    async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      let { data, error } = await client.rpc(name, args)
      // A just-issued Auth token can reach PostgREST before its clock catches up.
      // This rejection occurs before SQL executes; retry once without relaxing JWT checks.
      if (error?.code === 'PGRST303' && error.message === 'JWT issued at future') {
        await new Promise(resolve => setTimeout(resolve, 1100))
        ;({ data, error } = await client.rpc(name, args))
      }
      if (error) throw Object.assign(new Error(error.message), { code: error.code })
      return data as T
    }
    async function session(id: string): Promise<CloudSession> {
      const value = await rpc<CloudSession | null>('ru_session_json', { p_id: id })
      if (!value) throw Object.assign(new Error('Session not found.'), { code: 'P0002' })
      return value
    }
    if (req.method === 'GET') {
      if (path === '/state') {
        const value = await rpc<{active: CloudSession | null; server_now: string}>('ru_state')
        return json({ ...value, active: value.active && withReport(value.active) }, 200, origin)
      }
      if (path === '/settings') {
        return json(await rpc('ru_settings_get'), 200, origin)
      }
      if (path === '/history') {
        const value = await rpc<{sessions: CloudSession[]; total: number; page: number; page_size: number}>('ru_history', { p_days: Number(query.get('days') ?? 7), p_page: Number(query.get('page') ?? 0), p_search: query.get('search') ?? '', p_mode: query.get('mode') ?? '', p_status: query.get('status') ?? '' })
        return json({ ...value, sessions: value.sessions.map(withReport) }, 200, origin)
      }
      if (path === '/overview') return json(await rpc('ru_overview', { p_days: Number(query.get('days') ?? 7) }), 200, origin)
      if (path === '/export') return json(await rpc('ru_export_page', { p_before: query.get('before'), p_after: query.get('after') || null }), 200, origin)
      const match = path.match(/^\/sessions\/([0-9a-f-]{36})(\/analysis)?$/i)
      if (match) { const value = await session(match[1]); return json(match[2] ? studyReport(value) : withReport(value), 200, origin) }
    }
    if (req.method === 'POST') {
      if (!req.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'Expected JSON.' }, 415, origin)
      const reader = req.body?.getReader(); let bytes = 0; const chunks: Uint8Array[] = []
      if (reader) while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > 32768) { await reader.cancel(); return json({ error: 'Request too large.' }, 413, origin) }; chunks.push(chunk.value) }
      const joined = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length }
      const body = JSON.parse(new TextDecoder().decode(joined))
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected an object.')
      if (path === '/settings') return json(await rpc('ru_settings_save', { p_timezone: body.timezone, p_mode: body.default_mode }), 200, origin)
      if (path === '/commands') {
        if (body.action === 'reflection') body.data = validateReflection(body.data)
        if (body.action === 'annotations') body.data = { annotations: validateAnnotations(body.data?.annotations, await session(body.session_id)) }
        const result = await rpc<{session: CloudSession | null; deleted: boolean; replayed: boolean}>('ru_command', { p_action: body.action, p_command: body.command_id, p_tab: body.tab_id, p_id: body.session_id ?? null, p_revision: body.revision ?? null, p_data: body.data ?? {} })
        return json({ ...result, session: result.session && withReport(result.session) }, 200, origin)
      }
      if (path === '/account/delete') {
        if (body.confirm !== 'DELETE') throw new Error('Type DELETE to confirm account deletion.')
        const state = await rpc<{active: CloudSession | null}>('ru_state')
        if (state.active) throw new Error('End your active session before deleting your account.')
        const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
        const { error } = await admin.auth.admin.deleteUser(user.id)
        if (error) throw error
        return json({ deleted: true }, 200, origin)
      }
    }
    return json({ error: 'Not found.' }, 404, origin)
  } catch (error) {
    const e = error as {code?: string; message?: string}
    const status = e.code === '40001' || e.code === '23505' ? 409 : e.code === 'P0002' ? 404 : e.code === '28000' || e.code?.startsWith('PGRST30') ? 401 : e.code?.startsWith('XX') || e.code?.startsWith('08') ? 503 : 400
    // No request bodies, emails, task names, or tracking observations in logs.
    console.error(JSON.stringify({ requestId, status, code: e.code ?? 'validation' }))
    return json({ error: status === 503 ? 'Study storage is unavailable. Retry shortly.' : e.message ?? 'The request failed.', request_id: requestId }, status, origin)
  }
})
