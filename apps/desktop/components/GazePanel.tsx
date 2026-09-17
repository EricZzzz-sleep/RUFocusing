import { useEffect, useRef, useState } from 'react'
import { gazeRequest } from '../src/gaze-api'
import type { CameraStatus, DisplayGeometry, GazeState } from '../src/types'

const displayGeometry = (): DisplayGeometry => ({ width: window.screen.width, height: window.screen.height, device_pixel_ratio: window.devicePixelRatio })

export default function GazePanel({ enabled, busy, visible = true, cameraStatus }: { enabled: boolean; busy: boolean; visible?: boolean; cameraStatus?: CameraStatus; inSession?: boolean }) {
  const [stableQuality, setStableQuality] = useState('unavailable')
  const qualityCandidate = useRef({ value: 'unavailable', since: 0 })
  const [data, setData] = useState<GazeState | null>(null)
  const [fresh, setFresh] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [working, setWorking] = useState(false)
  const epoch = useRef(0)
  const commandBusy = useRef(false)
  const lastReceived = useRef(-Infinity)
  const calibrationId = useRef<string | null>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const fullscreenOwned = useRef(false)
  const starting = useRef(false)
  const cancelling = useRef(false)
  const attempt = useRef(0)
  const alive = useRef(true)
  const visibleRef = useRef(visible)
  const enabledRef = useRef(enabled)
  visibleRef.current = visible
  enabledRef.current = enabled

  useEffect(() => {
    alive.current = true
    let stopped = false
    let timeout: ReturnType<typeof setTimeout>
    async function poll() {
      const version = epoch.current
      const began = performance.now()
      try {
        const next = await gazeRequest(undefined, { calibration_id: calibrationId.current })
        if (!stopped && version === epoch.current && !commandBusy.current) {
          setData(next)
          const candidate = qualityCandidate.current
          if (candidate.value !== next.quality) qualityCandidate.current = { value: next.quality, since: performance.now() }
          else if (performance.now() - candidate.since >= 600) setStableQuality(next.quality)
          const timely = performance.now() - began < 750
          lastReceived.current = timely ? performance.now() : -Infinity
          setFresh(timely)
        }
      } catch { if (!stopped && version === epoch.current) setFresh(false) }
      if (!stopped) timeout = setTimeout(poll, 200)
    }
    void poll()
    const watchdog = setInterval(() => { if (performance.now() - lastReceived.current > 750) setFresh(false) }, 100)
    return () => { stopped = true; alive.current = false; clearTimeout(timeout); clearInterval(watchdog); void cancel() }
  }, [])

  async function command(action: string, body: object = {}) {
    if (commandBusy.current) return null
    commandBusy.current = true; const version = ++epoch.current; setWorking(true); setError('')
    try {
      const next = await gazeRequest(action, body)
      if (alive.current && version === epoch.current) { if (action === 'start') calibrationId.current = next.calibration.id; setData(next); setFresh(false) }
      return next
    } catch (reason) {
      if (alive.current && version === epoch.current) {
        setError(reason instanceof Error ? reason.message : 'The gaze request failed.')
        if (action === 'complete') { calibrationId.current = null; await leaveFullscreen() }
      }
      return null
    } finally { commandBusy.current = false; if (alive.current) setWorking(false) }
  }

  async function leaveFullscreen() {
    if (alive.current) setOpen(false)
    const owned = fullscreenOwned.current
    fullscreenOwned.current = false
    if (owned && document.fullscreenElement) await document.exitFullscreen().catch(() => {})
    if (alive.current && visibleRef.current) opener.current?.focus()
  }

  async function cancel() {
    attempt.current++
    const version = ++epoch.current
    if (alive.current) setFresh(false)
    const id = calibrationId.current
    calibrationId.current = null
    cancelling.current = true
    try {
      await leaveFullscreen()
      // A cancel may occur while a target POST is pending. It must not be dropped
      // by the normal command lock; the server serializes and validates the ID.
      if (id) {
        try {
          const next = await gazeRequest('reset', { calibration_id: id })
          if (alive.current && version === epoch.current) { setData(next); setFresh(false) }
        } catch { if (alive.current && version === epoch.current) setError('Calibration cancellation could not reach the service. It will expire when this page stops polling.') }
      }
    } finally { cancelling.current = false }
  }

  async function start() {
    if (busy || working || commandBusy.current || starting.current || cancelling.current || open || data?.diagnostic_check_active || !enabledRef.current || !visibleRef.current) return
    setError(''); setFresh(false)
    if (!document.documentElement.requestFullscreen) { setError('Fullscreen is required for display calibration. Use a browser with fullscreen support.'); return }
    const generation = ++attempt.current
    starting.current = true
    setWorking(true)
    try {
      await document.documentElement.requestFullscreen()
      fullscreenOwned.current = true
      if (!alive.current || generation !== attempt.current || !enabledRef.current || !visibleRef.current || document.hidden || !document.fullscreenElement) { await leaveFullscreen(); return }
      setOpen(true)
      const next = await command('start', { display: displayGeometry() })
      if (!next) { await leaveFullscreen(); return }
      // Escape can be pressed before the start request completes.
      if (!alive.current || generation !== attempt.current || !enabledRef.current || !visibleRef.current || document.hidden || !document.fullscreenElement) {
        const id = next.calibration.id
        if (calibrationId.current === id) calibrationId.current = null
        await leaveFullscreen()
        if (id) await gazeRequest('reset', { calibration_id: id })
        return
      }
      calibrationId.current = next.calibration.id
    } catch {
      if (alive.current && generation === attempt.current) setError('Gaze setup could not start. Check the camera and fullscreen access, then try again.')
      await leaveFullscreen()
    } finally { starting.current = false; if (alive.current) setWorking(false) }
  }

  useEffect(() => { if ((!visible || !enabled) && (open || calibrationId.current || starting.current)) void cancel() }, [visible, enabled, open])

  useEffect(() => {
    const modal = dialog.current
    if (open && modal && !modal.open) modal.showModal()
    return () => { if (modal?.open) modal.close() }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onFullscreen = () => { if (!document.fullscreenElement && fullscreenOwned.current) void cancel() }
    const onHidden = () => { if (document.hidden) void cancel() }
    document.addEventListener('fullscreenchange', onFullscreen)
    document.addEventListener('visibilitychange', onHidden)
    return () => { document.removeEventListener('fullscreenchange', onFullscreen); document.removeEventListener('visibilitychange', onHidden) }
  }, [open])

  useEffect(() => {
    if (!visible || !open || !data || working || commandBusy.current || !calibrationId.current) return
    const calibration = data.calibration
    if (calibration.id !== calibrationId.current) { calibrationId.current = null; void leaveFullscreen(); return }
    if (!enabled) { void cancel(); return }
    if (calibration.status === 'ready' || calibration.status === 'failed') { calibrationId.current = null; void leaveFullscreen(); return }
    if (error || calibration.collecting || calibration.target_error) return
    if (calibration.completed_targets === calibration.target_count) {
      void command('complete', { calibration_id: calibration.id })
    } else {
      // Acknowledge the painted target, then let the backend's settling period run.
      let second = 0
      const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
        if (calibrationId.current === calibration.id && visibleRef.current && enabledRef.current) {
          void command('target', { calibration_id: calibration.id, target_index: calibration.completed_targets })
        }
      }) })
      return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
    }
  }, [open, data, working, enabled, error, visible])

  useEffect(() => {
    if (!data?.calibration.display) return
    const expected = data.calibration.display
    let confirmed = ''
    let stopped = false
    const check = async () => {
      const actual = displayGeometry()
      const key = JSON.stringify(actual)
      if (open) {
        if (actual.width !== expected.width || actual.height !== expected.height || actual.device_pixel_ratio !== expected.device_pixel_ratio) void cancel()
        return
      }
      if (commandBusy.current || confirmed === key) return
      const version = epoch.current
      try {
        const next = await gazeRequest('display', { display: actual })
        if (!stopped && version === epoch.current && !commandBusy.current) {
          confirmed = key
          setData(next)
          setFresh(false)
        }
      } catch { /* Retry confirmation without hiding setup errors or accepting stale points. */ }
    }
    check()
    const retry = setInterval(() => void check(), 2000)
    window.addEventListener('resize', check)
    window.addEventListener('focus', check)
    return () => { stopped = true; clearInterval(retry); window.removeEventListener('resize', check); window.removeEventListener('focus', check) }
  }, [data?.calibration.id, open])

  const calibration = data?.calibration
  const target = calibration?.targets[Math.min(calibration.completed_targets, calibration.target_count - 1)]
  const ready = calibration?.status === 'ready'
  const reason = data?.observation.reason ?? ''
  const status = !enabled ? cameraStatus === 'unavailable' ? 'Gaze paused. Retry camera to resume tracking.' : cameraStatus === 'starting' ? 'Waiting for camera…' : 'Camera off' : !fresh ? 'Connecting gaze…' : !ready ? 'Set up gaze' :
    reason === 'display_changed_recalibrate' || reason === 'camera_config_changed_recalibrate' ? 'Setup needs updating' :
    reason.startsWith('seating_changed') ? 'Return to your setup position or redo setup' :
    data?.observation.valid ? 'Gaze ready' : reason === 'multiple_faces' ? 'Keep only one face in view' :
    reason === 'outside_calibrated_area' ? 'Look within your calibrated display' :
    reason === 'stale' || reason === 'camera_unavailable' ? 'Tracking unavailable. Check the camera.' : 'Waiting for your eyes'
  return <section className="gaze-panel compact-gaze" aria-label="Gaze setup">
    <div className="compact-gaze-row"><span className="gaze-message" role="status">{status}</span>
      <button ref={opener} type="button" className="text-button" disabled={!enabled || busy || working || open || data?.diagnostic_check_active} onClick={() => void start()}>{working ? 'Updating setup…' : ready ? 'Redo setup' : 'Set up gaze'}</button>
      {calibration?.id && !open && <details className="gaze-options"><summary>Setup options</summary><button type="button" className="text-button" disabled={busy || working} onClick={() => void command('reset')}>Reset gaze setup</button></details>}
    </div>
    {enabled && ready && reason === 'display_changed_recalibrate' && <p className="muted small">Return to the display used for setup, or redo setup for this display.</p>}
    {enabled && ready && reason === 'camera_config_changed_recalibrate' && <p className="muted small">Return to the camera used for setup, or redo setup for this camera.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {open && <dialog ref={dialog} className="calibration-screen" aria-labelledby="calibration-title" onCancel={event => { event.preventDefault(); void cancel() }} onKeyDown={event => {
      if (event.key !== 'Tab') return
      const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
      const first = buttons[0], last = buttons[buttons.length - 1]
      if (first && ((!event.shiftKey && document.activeElement === last) || (event.shiftKey && document.activeElement === first))) {
        event.preventDefault(); (event.shiftKey ? last : first).focus()
      }
    }}>
      <div className="calibration-heading"><h2 id="calibration-title">Look at the target</h2><p>Keep your head comfortably still and both eyes visible.</p></div>
      <button autoFocus className="button secondary calibration-cancel" type="button" onClick={() => void cancel()}>Cancel setup</button>
      {target && !calibration?.target_error && !error && <div className="calibration-target" role="img" style={{ left: `${target[0] * 100}%`, top: `${target[1] * 100}%` }} aria-label={`Look here: target ${Math.min((calibration?.completed_targets ?? 0) + 1, 13)} of 13`}><span /></div>}
      {(calibration?.target_error || error) && <div className="calibration-retry"><p role="alert">{calibration?.target_error || error}</p><button type="button" className="button primary" disabled={working} onClick={() => { setError(''); void command((calibration?.completed_targets ?? 0) >= 13 ? 'complete' : 'target', { calibration_id: calibrationId.current, target_index: calibration?.completed_targets }) }}>Retry target</button></div>}
      <p className="calibration-progress" role="status">{stableQuality !== 'usable' ? 'Keep both eyes visible. ' : ''}{calibration?.completed_targets ?? 0} / {calibration?.target_count ?? 13} targets</p>
    </dialog>}
  </section>
}
