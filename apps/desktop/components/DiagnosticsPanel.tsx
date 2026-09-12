import { useEffect, useRef, useState } from 'react'
import { diagnosticCommand, diagnosticsState } from '../src/diagnostics-api'
import type { DiagnosticConditions, DiagnosticState } from '../src/types'
import { duration } from '../src/types'
import DiagnosticResults from './DiagnosticResults'

const display = () => ({ width: window.screen.width, height: window.screen.height, device_pixel_ratio: window.devicePixelRatio })
export default function DiagnosticsPanel({ enabled, busy, visible, inSession, onCollectionChange }: { enabled: boolean; busy: boolean; visible: boolean; inSession: boolean; onCollectionChange: (active: boolean) => void }) {
  const [data, setData] = useState<DiagnosticState | null>(null)
  const [conditions, setConditions] = useState<DiagnosticConditions>({ lighting: 'normal', glasses: 'none', distance: 'normal', notes: '' })
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)
  const [open, setOpen] = useState(false)
  const owner = useRef<string | null>(null)
  const epoch = useRef(0), locked = useRef(false), alive = useRef(true), visibleRef = useRef(visible)
  visibleRef.current = visible
  const dialog = useRef<HTMLDialogElement>(null), opener = useRef<HTMLElement | null>(null)
  const ownsFullscreen = useRef(false)
  const awaitingFullscreen = useRef(false)
  const startId = useRef<string | null>(null)
  const [lastReceived, setLastReceived] = useState(0)

  useEffect(() => {
    alive.current = true
    let stopped = false
    let timeout: ReturnType<typeof setTimeout>
    async function poll() {
      const version = epoch.current
      try {
        const next = await diagnosticsState(owner.current)
        if (!stopped && version === epoch.current && !locked.current) { setData(next); setLastReceived(Date.now()); onCollectionChange(Boolean(next.check)) }
      } catch { if (!stopped) setLastReceived(0) }
      if (!stopped) timeout = setTimeout(poll, owner.current ? 200 : 1000)
    }
    void poll()
    return () => { stopped = true; alive.current = false; clearTimeout(timeout); owner.current = null }
  }, [onCollectionChange])

  async function command(group: 'checks' | 'trials', action: string, body: object) {
    if (locked.current) return null
    locked.current = true; setWorking(true); setError('')
    const version = ++epoch.current
    try {
      const next = await diagnosticCommand(group, action, body)
      if (alive.current && version === epoch.current) {
        if (group === 'checks' && action === 'start') owner.current = next.check?.id ?? null
        setData(next); setLastReceived(Date.now()); onCollectionChange(Boolean(next.check))
      }
      return next
    } catch (e) { if (alive.current && version === epoch.current) setError(e instanceof Error ? e.message : 'Diagnostic request failed.'); return null }
    finally { locked.current = false; if (alive.current) setWorking(false) }
  }
  async function leave() {
    setOpen(false)
    const owned = ownsFullscreen.current; ownsFullscreen.current = false
    if (owned && document.fullscreenElement) await document.exitFullscreen().catch(() => {})
    if (visibleRef.current && opener.current?.isConnected) opener.current.focus()
  }
  async function cancel() {
    epoch.current++; startId.current = null
    const id = owner.current; owner.current = null
    await leave()
    if (id) {
      try { const next = await diagnosticCommand('checks', 'cancel', { id }); if (alive.current) { setData(next); onCollectionChange(Boolean(next.check)) } }
      catch { if (alive.current) setError('Cancellation could not reach the service. Collection expires after three seconds without its owner.') }
    }
  }
  async function start(trial = false) {
    if (!enabled || busy || locked.current || awaitingFullscreen.current || !visibleRef.current) return
    if (!document.documentElement.requestFullscreen) { setError('Use a desktop browser with fullscreen support to check accuracy.'); return }
    opener.current = document.activeElement as HTMLElement
    startId.current = crypto.randomUUID()
    const attempt = startId.current
    awaitingFullscreen.current = true
    try {
      await document.documentElement.requestFullscreen(); ownsFullscreen.current = true
      if (!visibleRef.current || attempt !== startId.current) { await leave(); return }
      setOpen(true)
      if (trial) {
        const next = await command('trials', 'start', { request_id: `${attempt}-trial`, display: display(), conditions })
        if (!next) { await leave(); return }
        if (!visibleRef.current || !document.fullscreenElement || attempt !== startId.current) {
          if (next.trial) await diagnosticCommand('trials', 'stop', { id: next.trial.id })
          await leave(); return
        }
      }
      const next = await command('checks', 'start', { request_id: attempt, display: display(), conditions })
      if (!next) { await leave(); return }
      const id = next.check?.id
      if (!visibleRef.current || !document.fullscreenElement || attempt !== startId.current) {
        if (id) await diagnosticCommand('checks', 'cancel', { id })
        await leave(); return
      }
      owner.current = id ?? null
    } catch { setError('Fullscreen could not start. Allow fullscreen and try again.'); await leave() }
    finally { awaitingFullscreen.current = false }
  }

  useEffect(() => { if (!visible && (open || awaitingFullscreen.current)) void cancel() }, [visible, open])
  useEffect(() => {
    const modal = dialog.current
    if (open && modal && !modal.open) modal.showModal()
    return () => { if (modal?.open) modal.close() }
  }, [open])
  useEffect(() => {
    if (!open) return
    const changed = () => { if (!document.fullscreenElement || document.hidden) void cancel() }
    document.addEventListener('fullscreenchange', changed); document.addEventListener('visibilitychange', changed)
    return () => { document.removeEventListener('fullscreenchange', changed); document.removeEventListener('visibilitychange', changed) }
  }, [open])
  const check = data?.check
  useEffect(() => {
    if (!open || !visible || !owner.current || working || error) return
    if (!check || check.id !== owner.current) { owner.current = null; void leave(); return }
    if (!enabled) { void cancel(); return }
    if (check.collecting) return
    // Two animation frames acknowledge a painted target before the server starts settling.
    let second = 0
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
      if (!owner.current || !visibleRef.current) return
      void command('checks', check.completed_targets === 9 ? 'complete' : 'target', { id: owner.current, target_index: check.completed_targets })
    }) })
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
  }, [open, visible, check, working, error, enabled])

  const target = check?.target_order?.[Math.min(check.completed_targets ?? 0, 8)]
  const trial = data?.trial
  const canStart = lastReceived > 0 && enabled && !busy && !working && !open && data?.calibration_ready && !data?.check && !data?.calibration_busy
  return <section className="diagnostics-panel" aria-labelledby="diagnostics-title">
    <h3 id="diagnostics-title">Gaze reliability</h3>
    <p>Check measured accuracy without changing your calibration. Coverage is a baseline, not a pass/fail score.</p>
    <fieldset disabled={working || open}><legend>Test conditions</legend><div className="diagnostic-conditions">
      <label>Lighting<select value={conditions.lighting} onChange={e => setConditions({ ...conditions, lighting: e.target.value as DiagnosticConditions['lighting'] })}><option value="normal">Normal</option><option value="dim">Dim</option><option value="side">Side lighting</option></select></label>
      <label>Glasses<select value={conditions.glasses} onChange={e => setConditions({ ...conditions, glasses: e.target.value as DiagnosticConditions['glasses'] })}><option value="none">Not worn</option><option value="worn">Worn</option></select></label>
      <label>Seating distance<select value={conditions.distance} onChange={e => setConditions({ ...conditions, distance: e.target.value as DiagnosticConditions['distance'] })}><option value="normal">Normal</option><option value="near">Nearer</option><option value="far">Farther</option></select></label>
    </div><label>Notes (optional)<textarea maxLength={500} value={conditions.notes} onChange={e => setConditions({ ...conditions, notes: e.target.value })} /></label></fieldset>
    <div className="diagnostic-actions"><button type="button" className="button secondary" disabled={!canStart} onClick={() => void start()}>Check gaze accuracy</button><button type="button" className="button secondary" disabled={!canStart || !inSession || Boolean(trial)} onClick={() => void start(true)}>Start reliability trial</button></div>
    {!lastReceived && <p role="status">Waiting for the diagnostic service…</p>}
    {data?.save_error && <p className="error" role="alert">{data.save_error}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {trial && <div className="trial-status"><h4>25-minute reliability trial</h4><p>{trial.status === 'awaiting_initial' ? 'Run the initial accuracy check to begin.' : `${duration(trial.study_seconds ?? 0)} of ordinary study measured. Breaks and check windows excluded.`}</p>
      {trial.reminder && <div className="notice" role="status">{trial.reminder === 'initial' ? 'Initial' : trial.reminder === 'mid' ? '10-minute' : '25-minute'} accuracy check is due. Start it when you are ready.<div className="diagnostic-actions"><button className="text-button" type="button" disabled={!canStart} onClick={() => void start()}>Run due check</button><button className="text-button" type="button" disabled={working} onClick={() => void command('trials', 'reminder', { id: trial.id, checkpoint: trial.reminder })}>Dismiss reminder</button></div></div>}
      <button type="button" className="text-button" disabled={working} onClick={() => void command('trials', 'stop', { id: trial.id })}>Stop trial</button><p className="footnote">Stopping a trial does not end your study session.</p></div>}
    <h4>Recent diagnostics</h4><DiagnosticResults records={data?.recent ?? []} />
    {open && <dialog ref={dialog} className="calibration-screen accuracy-screen" aria-labelledby="accuracy-title" onCancel={event => { event.preventDefault(); void cancel() }} onKeyDown={event => {
      if (event.key !== 'Tab') return
      const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'), first = buttons[0], last = buttons[buttons.length - 1]
      if (first && ((!event.shiftKey && document.activeElement === last) || (event.shiftKey && document.activeElement === first))) { event.preventDefault(); (event.shiftKey ? last : first).focus() }
    }}><div className="calibration-heading"><h2 id="accuracy-title">Look at the accuracy target</h2><p>Keep your head comfortable and still. The estimated point is hidden.</p></div>
      <button autoFocus type="button" className="button secondary calibration-cancel" onClick={() => void cancel()}>Cancel accuracy check</button>
      {target && !error && <div className="calibration-target" role="img" aria-label={`Accuracy target ${(check?.completed_targets ?? 0) + 1} of 9`} style={{ left: `${target[0] * 100}%`, top: `${target[1] * 100}%` }}><span /></div>}
      {error && <div className="calibration-retry"><p role="alert">{error}</p><button type="button" className="button secondary" disabled={working} onClick={() => setError('')}>Retry request</button></div>}
      <p className="calibration-progress" role="status">{check?.completed_targets ?? 0} / 9 targets completed · 0.5s settling, then 3s measurement per target</p>
    </dialog>}
  </section>
}
