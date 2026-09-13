import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, newCommand, tabId, type Command, type CommandResult, type Session, type State } from './api'
import { mergeIntervals, type Interval, type Presence } from '../../../packages/study'

/** Telemetry is disposable. Only acknowledged server checkpoints are saved history. */
export class EvidenceBuffer {
  private rows: Interval[] = []
  private last = 0
  private current: Presence = 'unknown'
  reset(elapsed: number) { this.rows = []; this.last = elapsed; this.current = 'unknown' }
  observe(elapsed: number, state: Presence) {
    if (elapsed <= this.last) { this.current = state; return }
    const gap = elapsed - this.last
    this.rows = mergeIntervals([...this.rows, { start: this.last, end: elapsed, state: gap > 3 ? 'unknown' : this.current }])
    this.last = elapsed; this.current = state
  }
  snapshot(elapsed: number) { this.observe(elapsed, this.current); return this.rows.map(row => ({ ...row })) }
  acknowledge(elapsed: number) { this.rows = this.rows.filter(row => row.end > elapsed).map(row => ({ ...row, start: Math.max(row.start, elapsed) })); this.last = Math.max(this.last, elapsed) }
}
export function useStudySession(userId: string | undefined) {
  const [active, setActive] = useState<Session | null>(null)
  const [loaded, setLoaded] = useState(false), [connected, setConnected] = useState(true)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [retry, setRetry] = useState<Command | null>(null)
  const [version, setVersion] = useState(0)
  const state = useRef<Session | null>(null), commandBusy = useRef(false), epoch = useRef(0)
  const retryRef = useRef<Command | null>(null), accountRef = useRef(userId)
  accountRef.current = userId
  const anchor = useRef({ elapsed: 0, time: performance.now() })
  const buffer = useRef(new EvidenceBuffer())
  const generation = useRef(0)
  function elapsed() { return anchor.current.elapsed + (state.current?.status === 'running' && state.current.owner_tab === tabId ? Math.max(0, (performance.now() - anchor.current.time) / 1000) : 0) }
  function apply(session: Session | null, sentAt = performance.now(), reset = false) {
    const previous = state.current
    if (reset || previous?.id !== session?.id || previous?.status !== session?.status || previous?.owner_tab !== session?.owner_tab) buffer.current.reset(session?.elapsed ?? 0)
    else buffer.current.acknowledge(session?.elapsed ?? 0)
    // Server time is measured at request arrival; use a midpoint approximation only for live display.
    if (!session || session.revision !== previous?.revision || reset) anchor.current = { elapsed: session?.elapsed ?? 0, time: (sentAt + performance.now()) / 2 }
    state.current = session; setActive(session)
  }
  const refresh = useCallback(async () => {
    if (!userId || commandBusy.current) return
    const currentEpoch = epoch.current, account = userId, sent = performance.now()
    try {
      const result = await api<State>('/state')
      if (accountRef.current !== account || currentEpoch !== epoch.current || commandBusy.current) return
      apply(result.active, sent); setConnected(true); setLoaded(true)
    } catch (e) { if (accountRef.current === account && currentEpoch === epoch.current) { setConnected(false); setLoaded(true); setError(e instanceof Error ? e.message : 'Connection lost.') } }
  }, [userId])
  useEffect(() => {
    generation.current++; epoch.current++; commandBusy.current = false; setBusy(false); setError(''); setLoaded(false); setConnected(true); apply(null, performance.now(), true)
    const key = `rufocusing:pending:${userId}`
    let stored: Command | null = null
    if (userId) { try { const raw = sessionStorage.getItem(key); if (raw) stored = JSON.parse(raw) } catch { /* Optional retry storage. */ } }
    retryRef.current = stored; setRetry(stored)
    void refresh()
    const interval = setInterval(() => void refresh(), 5000)
    return () => { clearInterval(interval); generation.current++; epoch.current++ }
  }, [userId, refresh])
  async function run(command: Command): Promise<CommandResult> {
    if (!userId || commandBusy.current) throw new Error('A session command is already in progress.')
    commandBusy.current = true; epoch.current++; setBusy(true); setError('')
    const account = userId, gen = generation.current, sent = performance.now()
    const key = `rufocusing:pending:${account}`
    retryRef.current = command; setRetry(command)
    try { sessionStorage.setItem(key, JSON.stringify(command)) } catch { /* The in-memory retry remains available. */ }
    try {
      const result = await api<CommandResult>('/commands', command)
      if (accountRef.current !== account || generation.current !== gen) return result
      retryRef.current = null; setRetry(null); try { sessionStorage.removeItem(key) } catch { /* Optional. */ }
      const next = result.session?.status === 'running' || result.session?.status === 'break' ? result.session : null
      apply(next, sent); setConnected(true); setVersion(v => v + (command.action === 'checkpoint' ? 0 : 1))
      return result
    } catch (e) {
      if (accountRef.current === account && generation.current === gen) {
        setError(e instanceof Error ? e.message : 'Could not save the session.');
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
          retryRef.current = null; setRetry(null); try { sessionStorage.removeItem(key) } catch { /* Optional. */ }
        } else setConnected(false)
      }
      throw e
    } finally {
      if (accountRef.current === account && generation.current === gen) { commandBusy.current = false; setBusy(false); void refresh() }
    }
  }
  const runRef = useRef(run); runRef.current = run
  useEffect(() => {
    if (!userId) return
    const timer = setInterval(() => {
      const session = state.current
      if (commandBusy.current || retryRef.current || session?.status !== 'running' || session.owner_tab !== tabId) return
      const intervals = buffer.current.snapshot(elapsed())
      void runRef.current(newCommand('checkpoint', session, { intervals })).catch(() => {})
    }, 5000)
    return () => clearInterval(timer)
  }, [userId])
  async function command(action: string, data: Record<string, unknown> = {}) {
    if (retryRef.current) throw new Error('Retry the pending save first.')
    const intervals = state.current?.status === 'running' ? buffer.current.snapshot(elapsed()) : []
    return run(newCommand(action, action === 'start' ? null : state.current, { ...data, intervals }))
  }
  return { active, loaded, connected, busy, error, retry, version, elapsed, buffer: buffer.current,
    command, retrySave: () => retryRef.current ? run(retryRef.current) : Promise.resolve(null), refresh,
    observing: Boolean(active?.status === 'running' && active.camera_enabled && active.owner_tab === tabId && connected && (!retry || busy)),
    owned: Boolean(active?.owner_tab === tabId), setError }
}
export type SessionController = ReturnType<typeof useStudySession>
