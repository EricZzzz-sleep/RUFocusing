import { useCallback, useEffect, useRef, useState } from 'react'
import StudyTimeline from '../../desktop/components/StudyTimeline'
import StudyPatternReport from '../../desktop/components/StudyPatternReport'
import { duration } from '../../desktop/src/types'
import { modes, studyReport } from '../../../packages/study'
import { api, ApiError, newCommand, type Command, type CommandResult, type Session } from './api'
import { Link, navigate } from './Router'
export default function SessionDetails({ id, timezone, changed }: { id: string; timezone: string; changed: () => void }) {
  const [session, setSession] = useState<Session | null>(null), latest = useRef<Session | null>(null)
  const [task, setTask] = useState(''), [mode, setMode] = useState('Math'), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false), [retryLoad, setRetryLoad] = useState(0)
  const pending = useRef<Command | null>(null), commandBusy = useRef(false), alive = useRef(true)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    let stale = false; alive.current = true; setSession(null); setError('')
    api<Session>(`/sessions/${id}`).then(value => { if (!stale) { setSession(value); latest.current=value; setTask(value.task); setMode(value.mode) } }).catch(e => { if (!stale) setError(e.message) })
    return () => { stale = true; alive.current = false }
  }, [id, retryLoad])
  useEffect(() => { if (confirm) dialog.current?.showModal(); else dialog.current?.close() }, [confirm])
  const execute = useCallback(async (action: string, data: Record<string, unknown>): Promise<CommandResult> => {
    if (!latest.current || commandBusy.current) throw new Error('Wait for the report to load or finish saving.')
    if (pending.current && pending.current.action !== action) throw new Error('Retry the previous save first.')
    const cmd = pending.current ?? newCommand(action, latest.current, data)
    pending.current = cmd; commandBusy.current = true; setBusy(true); setError(''); setMessage('')
    try {
      let result = await api<CommandResult>('/commands', cmd)
      // Resolve an ambiguous prior save before applying a draft edited during the outage.
      if (result.session && JSON.stringify(cmd.data) !== JSON.stringify(data)) {
        const next = newCommand(action, result.session, data); pending.current = next
        result = await api<CommandResult>('/commands', next)
      }
      pending.current = null
      if (alive.current && result.session) { latest.current = result.session; setSession(result.session) }
      changed(); return result
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        pending.current = null
        if (e.status === 409) { const fresh = await api<Session>(`/sessions/${id}`); latest.current = fresh; if (alive.current) setSession(fresh) }
      }
      throw e
    } finally { commandBusy.current = false; if (alive.current) setBusy(false) }
  }, [id, changed])
  const transport = useCallback(async <T,>(path: string, data?: object): Promise<T> => {
    if (!data) return api<T>(path.replace(/^\/api/, ''))
    const action = path.endsWith('/reflection') ? 'reflection' : 'annotations'
    const result = await execute(action, data as Record<string, unknown>)
    return studyReport(result.session!) as T
  }, [execute])
  async function edit(event: React.FormEvent) {
    event.preventDefault(); try { await execute('edit', { task, mode }); setMessage('Session details saved.') } catch (e) { setError(e instanceof Error ? e.message : 'Could not save. Retry with your entries below.') }
  }
  async function remove() { try { await execute('delete', {}); setConfirm(false); navigate('/analysis') } catch (e) { setError(e instanceof Error ? e.message : 'Could not delete. Retry.'); setConfirm(false) } }
  return <><Link className="text-button" href="/analysis">← Back to analysis</Link><div className="page-heading"><div><p className="eyebrow">A RECORD OF YOUR TIME</p><h1>Session summary<span>.</span></h1></div></div>
    {error && <p className="error" role="alert">{error} {!session && <button className="text-button" onClick={() => setRetryLoad(v => v+1)}>Retry report</button>}</p>}
    {!session ? !error && <p role="status">Loading your session…</p> : <>
      <section className="panel"><span className="mode-tag">{session.mode}</span><h2>{session.task}</h2><p className="muted">{new Date(session.started_at).toLocaleString(undefined,{timeZone:timezone})} · {session.status}</p><p className="session-study-duration">{duration(session.elapsed-session.totals.break)} study time</p><StudyTimeline session={session}/></section>
      {['completed','interrupted'].includes(session.status) ? <><section className="panel"><h2>Session details</h2><form onSubmit={event => void edit(event)}><fieldset disabled={busy}><label>Task name<input required maxLength={200} value={task} onChange={event => setTask(event.target.value)}/></label><label>Study mode<select value={mode} onChange={event => setMode(event.target.value)}>{modes.map(value => <option key={value}>{value}</option>)}</select></label><p className="muted">Changing these labels leaves recorded timing unchanged.</p><button className="button primary">{busy ? 'Saving…' : 'Save session details'}</button></fieldset></form>{message && <p role="status">{message}</p>}</section>
      <section className="panel"><StudyPatternReport session={session} transport={transport}/></section><section className="panel danger-zone"><h2>Delete this session</h2><p>Remove its timeline, reflection, and personal tags from your account.</p><button className="button secondary danger" disabled={busy} onClick={() => setConfirm(true)}>Delete session</button></section></> : <Link href="/record" className="button primary">Return to active session</Link>}
    </>}
    <dialog ref={dialog} className="confirm-dialog" aria-labelledby="delete-session-title" onCancel={() => setConfirm(false)}><h2 id="delete-session-title">Delete this session?</h2><p>This permanently removes the saved session and its reflection.</p><div className="session-controls"><button autoFocus className="button secondary" disabled={busy} onClick={() => setConfirm(false)}>Keep session</button><button className="button primary danger" disabled={busy} onClick={() => void remove()}>{busy ? 'Deleting…' : 'Delete permanently'}</button></div></dialog>
  </>
}
