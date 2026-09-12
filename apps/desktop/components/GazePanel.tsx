import { useCallback, useEffect, useRef, useState } from 'react'
import { gazeRequest } from '../src/gaze-api'
import type { DisplayGeometry, GazeState } from '../src/types'
import DiagnosticsPanel from './DiagnosticsPanel'
import { gazeRegionLabels } from '../src/types'

const messages: Record<string, string> = {
  accuracy_check_failed_recalibrate: 'The accuracy check failed. Recalibrate before gaze estimates resume.',
  uncalibrated: 'Calibrate to estimate where you look on this display.',
  calibration_in_progress: 'Follow each target with your eyes. Keep your head comfortably still.',
  calibration_accuracy_failed: 'Calibration did not meet the accuracy checks. Improve lighting, keep both eyes visible, and try again.',
  camera_failed_recalibrate: 'The camera stopped. Retry the camera, then recalibrate.',
  camera_config_changed_recalibrate: 'The camera configuration changed. Calibrate again.',
  camera_restarted_recalibrate: 'The camera restarted. Calibrate again before tracking.',
  display_changed_recalibrate: 'The display configuration changed. Calibrate again.',
  seating_changed_recalibrate: 'Your seating position changed. Calibrate again.',
  seating_changed: 'Your position is outside the calibrated range. Return to your original position.',
  eyes_closed: 'Eyes are closed or not clearly visible.',
  no_face: 'Position your face in the camera view.', multiple_faces: 'Only one face can be tracked.',
  unavailable: 'Waiting for usable camera observations.', stale: 'Waiting for a fresh eye observation.',
  face_too_small: 'Move a little closer to the camera.', eyes_too_small: 'Move closer so both eyes are visible.',
  face_clipped: 'Keep your whole face inside the camera view.', extreme_head_angle: 'Face the display more directly.',
  unreliable_eyes: 'Eye landmarks are unreliable. Check lighting and camera framing.',
  invalid_landmarks: 'Eye landmarks are unavailable.', head_pose_unavailable: 'Head pose is unavailable.',
  outside_calibrated_area: 'The estimate is outside the calibrated display. No point is shown.',
  calibration_abandoned: 'Calibration was interrupted. Start again when ready.',
  calibration_interrupted: 'Calibration was interrupted. Enable the camera and start again.',
  calibration_reset: 'Calibration cleared. Calibrate when ready.', estimated: 'Experimental gaze estimate; this does not measure concentration.',
}
const explanation = (reason: string) => messages[reason] ?? 'Waiting for a usable, calibrated observation.'
const displayGeometry = (): DisplayGeometry => ({ width: window.screen.width, height: window.screen.height, device_pixel_ratio: window.devicePixelRatio })

export default function GazePanel({ enabled, busy, visible = true, inSession = false }: { enabled: boolean; busy: boolean; visible?: boolean; inSession?: boolean }) {
  const [diagnosticActive, setDiagnosticActive] = useState(false)
  const diagnosticActiveRef = useRef(false)
  const collectionChanged = useCallback((active: boolean) => {
    if (active !== diagnosticActiveRef.current) setFresh(false)
    diagnosticActiveRef.current = active
    setDiagnosticActive(active)
  }, [])
  const [stableQuality, setStableQuality] = useState('unavailable')
  const [stableTrackingReason, setStableTrackingReason] = useState('unavailable')
  const reasonCandidate = useRef({ value: 'unavailable', since: 0 })
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
  const alive = useRef(true)
  const visibleRef = useRef(visible)
  visibleRef.current = visible

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
          const reason = next.observation.reason
          if (reasonCandidate.current.value !== reason) reasonCandidate.current = { value: reason, since: performance.now() }
          else if (performance.now() - reasonCandidate.current.since >= 600) setStableTrackingReason(reason)
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
    return () => { stopped = true; alive.current = false; clearTimeout(timeout); clearInterval(watchdog) }
  }, [])

  async function command(action: string, body: object = {}) {
    if (commandBusy.current) return null
    commandBusy.current = true; const version = ++epoch.current; setWorking(true); setError('')
    try {
      const next = await gazeRequest(action, body)
      if (alive.current && version === epoch.current) { if (action === 'start') calibrationId.current = next.calibration.id; setData(next); setFresh(false) }
      return next
    } catch (reason) {
      if (alive.current && version === epoch.current) setError(reason instanceof Error ? reason.message : 'The gaze request failed.')
      return null
    } finally { commandBusy.current = false; if (alive.current) setWorking(false) }
  }

  async function leaveFullscreen() {
    setOpen(false)
    const owned = fullscreenOwned.current
    fullscreenOwned.current = false
    if (owned && document.fullscreenElement) await document.exitFullscreen().catch(() => {})
    if (visibleRef.current) opener.current?.focus()
  }

  async function cancel() {
    epoch.current++
    setFresh(false)
    const id = calibrationId.current
    calibrationId.current = null
    await leaveFullscreen()
    // A cancel may occur while a target POST is pending. It must not be dropped
    // by the normal command lock; the server serializes and validates the ID.
    if (id) {
      try {
        const next = await gazeRequest('reset', { calibration_id: id })
        if (alive.current) { setData(next); setFresh(false) }
      } catch { if (alive.current) setError('Calibration cancellation could not reach the service. It will expire when this page stops polling.') }
    }
  }

  async function start() {
    if (busy || working || diagnosticActive || data?.diagnostic_check_active || !enabled || !visibleRef.current) return
    setError(''); setFresh(false)
    if (!document.documentElement.requestFullscreen) { setError('Fullscreen is required for display calibration. Use a browser with fullscreen support.'); return }
    try {
      await document.documentElement.requestFullscreen()
      fullscreenOwned.current = true
      if (!visibleRef.current) { await leaveFullscreen(); return }
      setOpen(true)
      const next = await command('start', { display: displayGeometry() })
      if (!next) { await leaveFullscreen(); return }
      calibrationId.current = next.calibration.id
      // Escape can be pressed before the start request completes.
      if (!document.fullscreenElement || !visibleRef.current) await cancel()
    } catch { setError('Fullscreen could not start. Allow fullscreen and try again.'); await leaveFullscreen() }
  }

  useEffect(() => { if (!visible && (open || calibrationId.current)) void cancel() }, [visible, open])

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
    if (!enabled || calibration.id !== calibrationId.current) { void cancel(); return }
    if (calibration.status === 'ready' || calibration.status === 'failed') { calibrationId.current = null; void leaveFullscreen(); return }
    if (error || calibration.collecting || calibration.target_error) return
    if (calibration.completed_targets === calibration.target_count) {
      void command('complete', { calibration_id: calibration.id })
    } else {
      // The target is rendered at its server-defined location before collection
      // starts; the backend also discards the first 500 ms for settling.
      void command('target', { calibration_id: calibration.id, target_index: calibration.completed_targets })
    }
  }, [open, data, working, enabled, error, visible])

  useEffect(() => {
    if (!data?.calibration.display) return
    const expected = data.calibration.display
    const check = () => {
      const actual = displayGeometry()
      if (actual.width !== expected.width || actual.height !== expected.height || actual.device_pixel_ratio !== expected.device_pixel_ratio) {
        setFresh(false)
        if (open) void cancel()
        else void command('display', { display: actual })
      }
    }
    check()
    window.addEventListener('resize', check)
    window.addEventListener('focus', check)
    return () => { window.removeEventListener('resize', check); window.removeEventListener('focus', check) }
  }, [data?.calibration.display?.width, data?.calibration.display?.height, data?.calibration.display?.device_pixel_ratio, open])

  const calibration = data?.calibration
  const point = data?.observation
  const showPoint = Boolean(!diagnosticActive && !data?.diagnostic_check_active && enabled && fresh && calibration?.status === 'ready' && point?.valid && point.x != null && point.y != null)
  const target = calibration?.targets[Math.min(calibration.completed_targets, calibration.target_count - 1)]
  return <section className="panel gaze-panel" aria-labelledby="gaze-title">
    <div className="panel-heading"><div><span className="eyebrow">WHERE YOU LOOK</span><h2 id="gaze-title">Screen gaze</h2></div><span className="small-badge">Experimental</span></div>
    <div className="gaze-body">
      <p className="gaze-message" role="status">{!enabled ? 'Enable webcam observations to calibrate and track gaze.' : !fresh ? 'Waiting for the gaze service…' : explanation(calibration?.status === 'ready' ? stableTrackingReason : calibration?.reason ?? 'uncalibrated')}</p>
      <div className="gaze-map" style={calibration?.display ? { aspectRatio: `${calibration.display.width} / ${calibration.display.height}` } : undefined} role="img" aria-label={showPoint ? `Estimated gaze: ${gazeRegionLabels[point!.region!]}` : 'Calibrated display map; no valid gaze point'}>
        <span className="gaze-map-label">Calibrated display</span>
        {showPoint && <span className="gaze-point" data-testid="gaze-point" style={{ left: `${point!.x! * 100}%`, top: `${point!.y! * 100}%` }} />}
      </div>
      <p className="gaze-quality">Eyes: {stableQuality === 'usable' ? 'Usable landmarks' : explanation(stableQuality)}</p>
      {calibration?.validation && <p className="gaze-quality">Validation error: {calibration.validation.median_error == null ? 'unavailable' : `${(calibration.validation.median_error * 100).toFixed(1)}% median / ${((calibration.validation.p90_error ?? 0) * 100).toFixed(1)}% p90`} of display diagonal. {calibration.validation.accepted ? 'Calibration passed.' : 'Calibration failed.'}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <button ref={opener} type="button" className="button secondary" disabled={!enabled || busy || working || open || diagnosticActive || data?.diagnostic_check_active} onClick={() => void start()}>{working ? 'Updating calibration…' : calibration?.status === 'ready' ? 'Recalibrate gaze' : 'Calibrate gaze'}</button>
      {calibration?.rejections && Object.keys(calibration.rejections).length > 0 && <p className="gaze-quality">During calibration: {Object.entries(calibration.rejections).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason, count]) => `${explanation(reason)} (${count} observations)`).join(' ')}</p>}
      <p className="footnote">One display, one person. Follow 9 training targets and 4 accuracy checks. Gaze is not a measure of concentration.</p>
    </div>
    <DiagnosticsPanel enabled={enabled} busy={busy || working || open} visible={visible} inSession={inSession} onCollectionChange={collectionChanged} />
    {open && <dialog ref={dialog} className="calibration-screen" aria-labelledby="calibration-title" onCancel={event => { event.preventDefault(); void cancel() }} onKeyDown={event => {
      if (event.key !== 'Tab') return
      const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
      const first = buttons[0], last = buttons[buttons.length - 1]
      if (first && ((!event.shiftKey && document.activeElement === last) || (event.shiftKey && document.activeElement === first))) {
        event.preventDefault(); (event.shiftKey ? last : first).focus()
      }
    }}>
      <div className="calibration-heading"><h2 id="calibration-title">{calibration?.status === 'validating' ? 'Checking calibration accuracy' : 'Look at the target'}</h2><p>Keep your head comfortably still and both eyes visible.</p></div>
      <button autoFocus className="button secondary calibration-cancel" type="button" onClick={() => void cancel()}>Cancel calibration</button>
      {target && !calibration?.target_error && !error && <div className="calibration-target" role="img" style={{ left: `${target[0] * 100}%`, top: `${target[1] * 100}%` }} aria-label={`Look here: target ${Math.min((calibration?.completed_targets ?? 0) + 1, 13)} of 13`}><span /></div>}
      {(calibration?.target_error || error) && <div className="calibration-retry"><p role="alert">{calibration?.target_error || error}</p><button type="button" className="button primary" disabled={working} onClick={() => { setError(''); void command((calibration?.completed_targets ?? 0) >= 13 ? 'complete' : 'target', { calibration_id: calibrationId.current, target_index: calibration?.completed_targets }) }}>Retry target</button></div>}
      <p className="calibration-progress" role="status">{stableQuality !== 'usable' ? `${explanation(stableQuality)} ` : ''}{calibration?.completed_targets ?? 0} / 13 targets completed · {calibration?.samples ?? 0} usable frames collected for this target</p>
    </dialog>}
  </section>
}
