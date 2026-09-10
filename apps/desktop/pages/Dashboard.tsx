import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { request } from '../src/api'
import type { AppState, StudySession } from '../src/types'
import { cameraStatusLabels, duration, labels, studyModes, timer } from '../src/types'
import Timeline from '../components/Timeline'
import SessionDetails from '../components/SessionDetails'
import CameraPreview from '../components/CameraPreview'
import StudyTrends from '../components/StudyTrends'
import GazePanel from '../components/GazePanel'
import SessionHistory from '../components/SessionHistory'
import { dailyStudy, inPeriod, localDay, periods, summarize } from '../src/analysis'
import type { Period } from '../src/analysis'

const progress: Record<string, string> = {
  start: 'Starting session…', pause: 'Starting break…', resume: 'Resuming session…',
  end: 'Saving session…', camera: 'Updating camera…',
  'preview/start': 'Opening camera…', 'preview/stop': 'Closing preview…',
}

export default function Dashboard() {
  const [data, setData] = useState<AppState | null>(null)
  const [task, setTask] = useState('')
  const [mode, setMode] = useState('Math')
  const [camera, setCamera] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const busy = pending !== null
  const [period, setPeriod] = useState<Period>('7')
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(false)
  const [selected, setSelected] = useState<StudySession | null>(null)
  const busyRef = useRef(false)
  const pendingPreviewClose = useRef(false)
  const epoch = useRef(0)

  useEffect(() => {
    let stopped = false
    let timeout: ReturnType<typeof setTimeout>
    async function poll() {
      const version = epoch.current
      if (!busyRef.current) {
        try {
          const next = await request()
          if (!stopped && version === epoch.current) { setData(next); setConnected(true) }
        } catch {
          if (!stopped && version === epoch.current) setConnected(false)
        }
      }
      if (!stopped) timeout = setTimeout(poll, 1000)
    }
    void poll()
    return () => { stopped = true; clearTimeout(timeout) }
  }, [])

  async function action(name: string, body: object = {}, cameraCommand = false) {
    if (busyRef.current) return
    busyRef.current = true; epoch.current++; setPending(name); setError('')
    try {
      const next = await request(`/api/${cameraCommand ? 'camera' : 'sessions'}/${name}`, body)
      setData(next); setConnected(true)
      if (next.finished) { setSelected(next.finished); setPreviewOpen(false) }
      if (name === 'pause' || (name === 'camera' && !next.active?.camera_enabled)) setPreviewOpen(false)
      if (['start', 'resume', 'camera'].includes(name) && next.active?.camera_enabled && next.active.status === 'running' && !pendingPreviewClose.current) setPreviewOpen(true)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The request failed.') }
    finally {
      busyRef.current = false; setPending(null)
      if (pendingPreviewClose.current) {
        pendingPreviewClose.current = false
        void action('preview/stop', {}, true)
      }
    }
  }
  function openPreview() {
    if (busyRef.current) return
    setPreviewOpen(true)
    if (data?.observation.camera_status !== 'starting') void action('preview/start', {}, true)
  }
  function closePreview() {
    setPreviewOpen(false)
    if (busyRef.current) pendingPreviewClose.current = true
    else void action('preview/stop', {}, true)
  }
  function chooseCamera(enabled: boolean) {
    if (busyRef.current) return
    setCamera(enabled)
    if (enabled) openPreview()
    else closePreview()
  }
  function start(event: FormEvent) { event.preventDefault(); void action('start', { task, mode, camera }) }
  const active = data?.active
  const cameraStatus = connected ? data?.observation.camera_status ?? 'off' : 'unavailable'
  const cameraMessage = connected ? data?.observation.message ?? 'Camera is off.' : 'Waiting for the local service connection.'
  const observing = Boolean(data?.preview_active || (active?.camera_enabled && active.status === 'running'))
  // Reconcile preview visibility if another tab pauses, ends, or disables observations.
  useEffect(() => {
    if (data?.active && (data.active.status === 'break' || !data.active.camera_enabled)) setPreviewOpen(false)
    if (data && !data.active && !data.preview_active && data.observation.camera_status === 'off' && !busyRef.current) setPreviewOpen(false)
  }, [data])
  const day = localDay(new Date())
  const history = useMemo(() => inPeriod(data?.history ?? [], period), [data?.history, period, day])
  const daily = useMemo(() => dailyStudy(history, period), [history, period, day])
  const summary = summarize(history)
  const metrics = [
    ['Saved sessions', String(summary.count), 'Completed & interrupted'],
    ['Study time', duration(summary.study), 'Excluding breaks'],
    ['At-desk time', duration(summary.present), 'Face-presence estimate'],
    ['Longest at-desk period', duration(summary.longest), 'Continuous face presence'],
    ['Observation coverage', summary.coverage, 'Observed / study time'],
  ]

  return <>
    <a className="skip-link" href="#main-content">Skip to study workspace</a>
    <header className="app-header"><div className="header-inner"><a className="brand" href="/" aria-label="RUFocusing home"><span className="brand-mark" aria-hidden="true">r<span>u</span></span>RUFocusing<span className="brand-divider" /><span className="header-section">Study space</span></a><span className={`connection ${connected ? 'online' : ''}`}><i />{connected ? 'Local workspace' : 'Connecting…'}</span></div></header>
    <main id="main-content" tabIndex={-1}>
      <div className="page-heading"><div><p className="eyebrow">A LITTLE MORE INTENTION</p><h1>Your study overview<span>.</span></h1><p className="intro">Make time for your work. See how each session unfolds.</p></div><a className="button secondary session-jump" href="#session">{active ? 'Go to active session' : 'Record a session'}<span aria-hidden="true">↓</span></a></div>
      {!connected && <div className="notice" role="status">{data ? 'Connection lost. Reconnecting to your local session…' : 'Connecting to the local service. If this persists, start the app with make run.'}</div>}
      {error && <div className="error" role="alert">{error}</div>}
      <div className="overview-heading"><div><h2>Saved session overview</h2><p>Presence estimates across your recorded study time.</p></div><div className="period-control"><label htmlFor="period">Date range</label><select id="period" value={period} onChange={event => setPeriod(event.target.value as Period)}>{(Object.keys(periods) as Period[]).map(value => <option key={value} value={value}>{periods[value]}</option>)}</select></div></div>
      <section className="metrics" aria-label="Saved session overview">{metrics.map(([label, value, caption], index) => <div className={`metric ${index === 2 ? 'featured' : ''}`} key={label}><span className="metric-label">{label}</span><strong>{data ? value : '—'}</strong><span className="metric-caption">{caption}</span></div>)}</section>
      <StudyTrends days={daily} loading={!data} />
      <div className="workspace-grid">
          <section className="panel session-panel" id="session" tabIndex={-1} aria-label="Session recording">
            <div className="panel-heading"><div><span className="eyebrow">{active ? 'IN PROGRESS' : 'ONE THING AT A TIME'}</span><h2>{active ? active.task : 'Settle into a session'}</h2></div><span className={`small-badge ${active ? 'is-active' : ''}`}>{active ? active.status === 'break' ? 'On a break' : 'Session active' : 'Ready when you are'}</span></div>
            {active ? <>
              <div className="timer-area"><span className="mode-tag">{active.mode}</span><div className="timer" role="timer" aria-label="Elapsed session time">{timer(active.elapsed)}</div><span className={`presence-pill ${connected ? data!.state : 'unknown'}`}><i />{connected ? labels[data!.state] : 'Connection lost'}{connected && data!.state === 'away' ? ' · estimated' : ''}</span>{!connected && <p className="timer-note">Last received time. Reconnecting to your running session…</p>}</div>
              <div className="session-controls"><button type="button" className="button secondary" disabled={busy || !connected} onClick={() => void action(active.status === 'break' ? 'resume' : 'pause')}>{pending === 'pause' || pending === 'resume' ? progress[pending] : active.status === 'break' ? 'Resume session' : 'Take a break'}</button><button type="button" className="button primary" disabled={busy || !connected} onClick={() => void action('end')}>{pending === 'end' ? 'Saving session…' : 'End & save session'}<span aria-hidden="true">↗</span></button></div>
              <Timeline session={active} />
            </> : <form onSubmit={start}>
              <label htmlFor="task">What are you working on?</label><input id="task" value={task} onChange={event => setTask(event.target.value)} placeholder="e.g. Linear algebra · Problem set 03" maxLength={200} required autoComplete="off" />
              <div className="form-row"><div><label htmlFor="mode">Study mode</label><select id="mode" value={mode} onChange={event => setMode(event.target.value)}>{studyModes.map(item => <option key={item}>{item}</option>)}</select></div><div className="camera-choice"><label className="checkbox-label"><input type="checkbox" checked={camera} disabled={busy || !connected} onChange={event => chooseCamera(event.target.checked)} />Use webcam observations</label><p>Face presence & head pose. No video saved.</p>{camera && <button type="button" className="text-button setup-preview-button" disabled={busy || !connected} onClick={openPreview}>Preview camera</button>}</div></div>
              <div className="form-footer"><span>Your session stays on this device.</span><button type="submit" className="button primary" disabled={busy || !connected || !task.trim()}>{pending === 'start' ? 'Starting session…' : 'Start session'}<span aria-hidden="true">→</span></button></div>
            </form>}
          </section>
        <aside>
          <section className="panel observation-panel"><div className="panel-heading"><div><span className="eyebrow">THE HERE & NOW</span><h2>Observations</h2></div><span className={`camera-status ${cameraStatus}`} role="status">Camera: {cameraStatusLabels[cameraStatus]}</span></div>
            {active && <div className="live-camera-control"><label className="checkbox-label"><input type="checkbox" checked={active.camera_enabled} disabled={busy || !connected} onChange={event => void action('camera', { enabled: event.target.checked })} />Webcam observations</label><p>{active.status === 'break' ? active.camera_enabled ? 'Camera stays off during your break. Observations will resume with your session.' : 'Camera stays off during your break and on resume.' : active.camera_enabled ? 'Observations are on. Closing the preview keeps tracking on.' : 'Camera is off. Your timer continues; this time is marked unknown.'}</p></div>}
            <div className={`observation-visual ${cameraStatus === 'ready' && data?.observation.face_count === 1 ? 'detected' : ''}`} aria-hidden="true"><div className="focus-corners"><span className="observation-glyph">◎</span></div></div>
            <h3 className="observation-title">{cameraStatus === 'starting' ? 'Starting your camera' : cameraStatus === 'unavailable' ? 'Camera unavailable' : cameraStatus === 'ready' ? data?.observation.face_count === 1 ? 'Face detected' : data?.observation.face_count === 0 ? 'Looking for a face' : 'Multiple faces' : active?.status === 'break' ? 'Camera paused' : active ? 'Timer-only session' : 'Your space, your choice'}</h3>
            <p className="observation-message">{cameraMessage}</p>
            <div className="pose-readings">{(['pitch', 'yaw', 'roll'] as const).map(axis => <div key={axis}><span>{axis}</span><strong>{cameraStatus === 'ready' && data && data.observation[axis] != null ? `${data.observation[axis]}°` : '—'}</strong></div>)}</div>
            {observing && <button type="button" className="button secondary show-preview" disabled={busy || !connected || (cameraStatus === 'starting' && previewOpen)} onClick={openPreview}>{cameraStatus === 'unavailable' ? 'Retry camera' : 'Show camera preview'}</button>}
            <p className="footnote">Angles are approximate. Looking down does not mark you as away.</p>
          </section>
          <GazePanel enabled={observing && connected && cameraStatus === 'ready'} busy={busy} />
          <section className="explanation-card"><span className="eyebrow">WHAT THE TIMELINE TELLS YOU</span><h2>Presence is a starting point.</h2><p>At desk means a face was detected. Away means no face was detected for at least 10 seconds.</p><p>Missing camera data stays unknown. These observations describe your session, not how deeply you were focused.</p><div className="privacy-line"><span aria-hidden="true">◎</span> Local processing. No video recordings.</div></section>
        </aside>
        <SessionHistory sessions={history} loading={!data} onSelect={setSelected} />
      </div>
      <footer><span>RUFocusing <span aria-hidden="true">/</span> A little time, well understood.</span><span>Saved on your device</span></footer>
    </main>
    <div className="action-status" role="status" aria-live="polite">{pending ? progress[pending] : ''}</div>
    {previewOpen && <CameraPreview status={cameraStatus} message={cameraMessage} inSession={Boolean(active)} onClose={closePreview} onRetry={openPreview} busy={busy || !connected} />}
    {selected && <SessionDetails session={selected} onClose={() => setSelected(null)} />}
  </>
}
