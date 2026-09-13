import { createClient } from '@supabase/supabase-js'
import type { CloudSession, withReport } from '../../../packages/study'
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined
export const configured = Boolean(url && key)
export const auth = configured ? createClient(url!, key!, { auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true } }) : null
export const tabId = crypto.randomUUID()
export type Session = ReturnType<typeof withReport>
export interface Settings { timezone: string | null; default_mode: string }
export interface State { active: Session | null; server_now: string }
export interface Command { action: string; command_id: string; tab_id: string; session_id?: string; revision?: number; data: Record<string, unknown> }
export interface CommandResult { session: Session | null; deleted: boolean; replayed: boolean }
export class ApiError extends Error { constructor(message: string, public status: number) { super(message) } }
export async function api<T>(path: string, data?: unknown): Promise<T> {
  if (!auth) throw new ApiError('Cloud sign-in is not available yet.', 503)
  const { data: { session }, error } = await auth.auth.getSession()
  if (error || !session) throw new ApiError('Sign in to continue.', 401)
  let response: Response
  try {
    response = await fetch(`${url}/functions/v1/api${path}`, { method: data === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: key!, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(15000) })
  } catch { throw new ApiError('Connection lost. Your last acknowledged checkpoint is safe. Retry when connected.', 0) }
  const body = await response.json().catch(() => null)
  if (!response.ok || !body) throw new ApiError(body?.error || 'Study storage is unavailable. Retry shortly.', response.status || 503)
  return body as T
}
export function newCommand(action: string, session: Pick<CloudSession, 'id' | 'revision'> | null, data: Record<string, unknown> = {}): Command {
  return { action, command_id: crypto.randomUUID(), tab_id: tabId, ...(session ? { session_id: session.id, revision: session.revision } : {}), data }
}
export function savePreference(key: string, value: string) { try { localStorage.setItem(`rufocusing:${key}`, value) } catch { /* Storage is optional. */ } }
export function preference(key: string, fallback = '') { try { return localStorage.getItem(`rufocusing:${key}`) ?? fallback } catch { return fallback } }
