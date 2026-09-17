import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { request } from '../src/api'
import type { AppState, StudySession, WorkspacePage, PreviewPosition } from '../src/types'
import { cameraStatusLabels, studyModes, timer } from '../src/types'
import StudyTimeline, { StudyTotals, sumStudyPeriods } from '../components/StudyTimeline'
import SessionDetails from '../components/SessionDetails'
import CameraPreview from '../components/CameraPreview'
import GazePanel from '../components/GazePanel'
import SessionHistory from '../components/SessionHistory'
import PrivacyStorage from '../components/PrivacyStorage'
import { inPeriod, localDay, periods } from '../src/analysis'
import type { Period } from '../src/analysis'

// The diagnostics module and its controls are excluded from production bundles.
const DiagnosticsPanel = import.meta.env.DEV ? lazy(() => import('../components/DiagnosticsPanel')) : null

const progress: Record<string, string> = {
  start: 'Starting session…', pause: 'Starting break…', resume: 'Resuming session…',
  end: 'Saving session…', camera: 'Updating camera…',
  'preview/start': 'Opening camera…', 'preview/stop': 'Closing preview…',
}

export default function Dashboard() {
  const [page, setPage] = useState<WorkspacePage>(() => window.location.hash === '#record' ? 'record' : window.location.hash === '#privacy' ? 'privacy' : 'analysis')
  const pageRef = useRef(page)
  const previewGeneration = useRef(0)
  const [previewPosition, setPreviewPosition] = useState<PreviewPosition | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const [data, setData] = useState<AppState | null>(null)
  const [task, setTask] = useState('')
  const [mode, setMode] = useState('Math')
  const [camera, setCamera] = useState(false)
  const [diagnosticCollecting, setDiagnosticCollecting] = useState(false)
  const diagnosticsEnabled = import.meta.env.DEV && new URLSearchParams(window.location.search).get('diagnostics') === '1'
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
  const lastReceived = useRef(-Infinity)

  useEffect(() => {
    let stopped = false
    let timeout: ReturnType<typeof setTimeout>
    async function poll() {
      const version = epoch.current
      if (!busyRef.current) {
        const began = performance.now()
        try {
          const next = await request()
          if (!stopped && version === epoch.current) {
            const timely = performance.now() - began < 2000
            lastReceived.current = timely ? performance.now() : -Infinity
            setData(next); setConnected(timely)
          }
        } catch {
          if (!stopped && version === epoch.current) setConnected(false)
        }
      }
      if (!stopped) timeout = setTimeout(poll, 1000)
    }
    void poll()
    const watchdog = setInterval(() => { if (performance.now() - lastReceived.current >= 2000) setConnected(false) }, 100)
    return () => { stopped = true; clearTimeout(timeout); clearInterval(watchdog) }
  }, [])

  function navigate(next: WorkspacePage, push = true) {
    if (window.location.hash !== `#${next}`) window.history[push ? 'pushState' : 'replaceState'](null, '', `#${next}`)
    if (pageRef.current === next) return
    pageRef.current = next
    previewGeneration.current++
    setPage(next)
    setSelected(null)
    if (next !== 'record') closePreview()
  }
  useEffect(() => {
    const changed = () => navigate(window.location.hash === '#record' ? 'record' : window.location.hash === '#privacy' ? 'privacy' : 'analysis', false)
    changed()
    window.addEventListener('hashchange', changed)
    window.addEventListener('popstate', changed)
    return () => { window.removeEventListener('hashchange', changed); window.removeEventListener('popstate', changed) }
  }, [])
  useEffect(() => { if (!selected) heading.current?.focus() }, [page])

  async function action(name: string, body: object = {}, cameraCommand = false) {
    if (busyRef.current) return
    const generation = previewGeneration.current
    busyRef.current = true; epoch.current++; setPending(name); if (name !== 'preview/stop') setError('')
    try {
      const next = await request(`/api/${cameraCommand ? 'camera' : 'sessions'}/${name}`, body)
      lastReceived.current = performance.now()
      setData(next); setConnected(true)
      if (next.finished) { navigate('analysis'); setSelected(next.finished); setPreviewOpen(false) }
      if (name === 'pause' || (name === 'camera' && !next.active?.camera_enabled)) setPreviewOpen(false)
      if (['start', 'resume', 'camera'].includes(name) && next.active?.camera_enabled && next.active.status === 'running' && !pendingPreviewClose.current && pageRef.current === 'record' && generation === previewGeneration.current) setPreviewOpen(true)
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
    if (busyRef.current || pageRef.current !== 'record') return
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
  const studyPeriods = useMemo(() => sumStudyPeriods(history), [history])

  return <>
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>Skip to study workspace</a>
    <header className="app-header"><div className="header-inner"><a className="brand" href="#analysis" onClick={event => { event.preventDefault(); navigate('analysis') }} aria-label="RUFocusing home"><span className="brand-mark" aria-hidden="true">r<span>u</span></span>RUFocusing<span className="brand-divider" /><span className="header-section">Study space</span></a><span className={`connection ${connected ? 'online' : ''}`}><i />{connected ? 'Local workspace' : 'Connecting…'}</span></div></header>
    <main id="main-content" tabIndex={-1}>
      <nav className="workspace-nav" aria-label="Study workspace">{(['analysis', 'record', 'privacy'] as const).map(item => <a key={item} href={`#${item}`} aria-current={page === item ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate(item) }}>{item === 'analysis' ? 'Analysis' : item === 'privacy' ? 'Privacy & storage' : 'Record'}</a>)}</nav>
      <div className="page-heading"><div><p className="eyebrow">{page === 'analysis' ? 'A LITTLE MORE INTENTION' : page === 'privacy' ? 'ON YOUR DEVICE' : 'ONE THING AT A TIME'}</p><h1 ref={heading} tabIndex={-1}>{page === 'analysis' ? 'Your study overview' : page === 'privacy' ? 'Privacy & storage' : 'Your study session'}<span>.</span></h1><p className="intro">{page === 'analysis' ? 'Make time for your work. See how each session unfolds.' : page === 'privacy' ? 'Manage the data saved on this device.' : 'Choose a task and make time to study.'}</p></div>{page === 'analysis' && <a className="button secondary session-jump" href="#record" onClick={event => { event.preventDefault(); navigate('record') }}>{active ? 'Return to session' : 'Record a session'}<span aria-hidden="true">→</span></a>}</div>
      {page === 'analysis' && active && <div className="notice active-session-status">{active.status === 'break' ? 'On a break' : 'Session running'} · {active.task} · {timer(active.elapsed)}</div>}
      {!connected && <div className="notice" role="status">{data ? 'Connection lost. Reconnecting to your local session…' : 'Connecting to the local service. If this persists, restart RUFocusing. In development, use make run.'}</div>}
      {error && <div className="error" role="alert">{error}</div>}
      <div hidden={page !== 'analysis'}>
      <div className="overview-heading"><div><h2>Your study time</h2></div><div className="period-control"><label htmlFor="period">Date range</label><select id="period" value={period} onChange={event => setPeriod(event.target.value as Period)}>{(Object.keys(periods) as Period[]).map(value => <option key={value} value={value}>{periods[value]}</option>)}</select></div></div>
      <StudyTotals periods={studyPeriods} loading={!data} />
      <SessionHistory sessions={history} loading={!data} onSelect={setSelected} />
      </div>
      <div hidden={page !== 'record'}>
      <div className="workspace-grid simple-workspace">
        <div className="session-column">
          <section className="panel session-panel" id="session" tabIndex={-1} aria-label="Session recording">
            <div className="panel-heading"><div><span className="eyebrow">{active ? 'IN PROGRESS' : 'ONE THING AT A TIME'}</span><h2>{active ? active.task : 'Settle into a session'}</h2></div><span className={`small-badge ${active ? 'is-active' : ''}`}>{active ? active.status === 'break' ? 'On a break' : 'Session active' : 'Ready when you are'}</span></div>
            {active ? <>
              <div className="timer-area"><span className="mode-tag">{active.mode}</span><div className="timer" role="timer" aria-label="Elapsed session time">{timer(active.elapsed)}</div>{!connected && <p className="timer-note">Last received time. Reconnecting to your running session…</p>}</div>
              <div className="session-controls"><button type="button" className="button secondary" disabled={busy || !connected} onClick={() => void action(active.status === 'break' ? 'resume' : 'pause')}>{pending === 'pause' || pending === 'resume' ? progress[pending] : active.status === 'break' ? 'Resume session' : 'Take a break'}</button><button type="button" className="button primary" disabled={busy || !connected} onClick={() => void action('end')}>{pending === 'end' ? 'Saving session…' : 'End & save session'}<span aria-hidden="true">↗</span></button></div>
              <StudyTimeline session={active} />
            </> : <form onSubmit={start}>
              <label htmlFor="task">What are you working on?</label><input id="task" value={task} onChange={event => setTask(event.target.value)} placeholder="e.g. Linear algebra · Problem set 03" maxLength={200} required autoComplete="off" />
              <div className="form-row"><div><label htmlFor="mode">Study mode</label><select id="mode" value={mode} onChange={event => setMode(event.target.value)}>{studyModes.map(item => <option key={item}>{item}</option>)}</select></div><div className="camera-choice"><span className="muted small">Camera setup is optional.</span></div></div>
              <div className="form-footer"><span>Your session stays on this device.</span><button type="submit" className="button primary" disabled={busy || !connected || !task.trim()}>{pending === 'start' ? 'Starting session…' : 'Start session'}<span aria-hidden="true">→</span></button></div>
            </form>}
          </section>
          <section className="panel setup-panel" aria-label="Camera and gaze setup">
            <div className="panel-heading"><h2>Camera & gaze</h2><span className={`camera-status ${cameraStatus}`} role="status">Camera: {cameraStatusLabels[cameraStatus]}</span></div>
            <div className="compact-camera-controls live-camera-control">
              <label className="checkbox-label"><input type="checkbox" checked={active ? active.camera_enabled : camera} disabled={busy || !connected} onChange={event => active ? void action('camera', { enabled: event.target.checked }) : chooseCamera(event.target.checked)} />Use camera</label>
              {(observing || (camera && !active)) && <button type="button" className="text-button" disabled={busy || !connected || (cameraStatus === 'starting' && previewOpen)} onClick={openPreview}>{cameraStatus === 'unavailable' ? 'Retry camera' : 'Show camera preview'}</button>}
              <span className="muted small">{active?.status === 'break' ? 'Camera paused during break.' : 'Processed locally. No video saved.'}</span>
            </div>
            {cameraStatus === 'unavailable' && observing && <p className="setup-notice" role="status">{cameraMessage} {active && 'Your timer continues. Missing tracking is shown as a gap.'}</p>}
            <GazePanel visible={page === 'record'} enabled={observing && connected && cameraStatus === 'ready'} cameraStatus={cameraStatus} busy={busy || diagnosticCollecting} />
            {diagnosticsEnabled && DiagnosticsPanel && <Suspense fallback={<p role="status">Loading local diagnostics…</p>}><DiagnosticsPanel
              visible={page === 'record'} enabled={observing && connected && cameraStatus === 'ready'} busy={busy}
              inSession={Boolean(active)} onCollectionChange={setDiagnosticCollecting} /></Suspense>}
          </section>
        </div>

      </div>
      </div>
      {page === 'privacy' && <PrivacyStorage sessions={data?.history ?? []} active={Boolean(active)} onChange={async () => { epoch.current++; setData(await request()); setSelected(null) }} />}
      <footer><span>RUFocusing <span aria-hidden="true">/</span> A little time, well understood.</span><span>Saved on your device</span></footer>
    </main>
    <div className="action-status" role="status" aria-live="polite">{pending ? progress[pending] : ''}</div>
    {page === 'record' && previewOpen && <CameraPreview position={previewPosition} onPositionChange={setPreviewPosition} status={cameraStatus} message={cameraMessage} inSession={Boolean(active)} onClose={closePreview} onRetry={openPreview} busy={busy || !connected} />}
    {selected && <SessionDetails session={selected} onClose={() => setSelected(null)} />}
  </>
}
