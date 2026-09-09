import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { request } from '../src/api'
import type { AppState, StudySession } from '../src/types'
import { cameraStatusLabels, dateLabel, duration, labels, timer } from '../src/types'
import Timeline from '../components/Timeline'
import SessionDetails from '../components/SessionDetails'
import CameraPreview from '../components/CameraPreview'

export default function Dashboard() {
  const [data, setData] = useState<AppState | null>(null)
  const [task, setTask] = useState('')
  const [mode, setMode] = useState('Math')
  const [camera, setCamera] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [busy, setBusy] = useState(false)
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
    busyRef.current = true; epoch.current++; setBusy(true); setError('')
    try {
      const next = await request(`/api/${cameraCommand ? 'camera' : 'sessions'}/${name}`, body)
      setData(next); setConnected(true)
      if (next.finished) { setSelected(next.finished); setPreviewOpen(false) }
      if (name === 'pause') setPreviewOpen(false)
      if (name === 'start' && next.active?.camera_enabled && !pendingPreviewClose.current) setPreviewOpen(true)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The request failed.') }
    finally {
      busyRef.current = false; setBusy(false)
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
    setCamera(enabled)
    if (enabled) openPreview()
    else closePreview()
  }
  function start(event: FormEvent) { event.preventDefault(); void action('start', { task, mode, camera }) }
  const active = data?.active
  const cameraStatus = connected ? data?.observation.camera_status ?? 'off' : 'unavailable'
  const cameraMessage = connected ? data?.observation.message ?? 'Camera is off.' : 'Waiting for the local service connection.'
  const observing = Boolean(data?.preview_active || (active?.camera_enabled && active.status === 'running'))
  const history = data?.history ?? []
  const studyTime = history.reduce((sum, session) => sum + session.elapsed - session.totals.break, 0)
  const presentTime = history.reduce((sum, session) => sum + session.totals.present, 0)
  const longest = Math.max(0, ...history.map(session => session.longest_present))
  const metrics = [
    ['Saved sessions', String(history.length), 'Completed & interrupted'],
    ['Study time', duration(studyTime), 'Excluding breaks'],
    ['At-desk time', duration(presentTime), 'Face-presence estimate'],
    ['Longest period', duration(longest), 'Uninterrupted face presence'],
  ]

  return <>
    <header className="app-header"><div className="header-inner"><a className="brand" href="/" aria-label="RUFocusing home"><span className="brand-mark" aria-hidden="true">r<span>u</span></span>RUFocusing<span className="brand-divider" /><span className="header-section">Study space</span></a><span className={`connection ${connected ? 'online' : ''}`}><i />{connected ? 'Local workspace' : 'Connecting…'}</span></div></header>
    <main>
      <div className="page-heading"><div><p className="eyebrow">A LITTLE MORE INTENTION</p><h1>Your study overview<span>.</span></h1><p className="intro">Make time for your work. See how each session unfolds.</p></div><span className="phase-tag">Phase 1 <span>·</span> Presence & sessions</span></div>
      {!connected && <div className="notice" role="status">{data ? 'Connection lost. Reconnecting to your local session…' : 'Connecting to the local service. If this persists, start the app with make run.'}</div>}
      {error && <div className="error" role="alert">{error}</div>}
      <section className="metrics" aria-label="Saved session overview">{metrics.map(([label, value, caption], index) => <div className={`metric ${index === 2 ? 'featured' : ''}`} key={label}><span className="metric-label">{label}</span><strong>{data ? value : '—'}</strong><span className="metric-caption">{caption}</span></div>)}</section>
      <div className="workspace-grid">
        <div className="main-column">
          <section className="panel session-panel">
            <div className="panel-heading"><div><span className="eyebrow">{active ? 'IN PROGRESS' : 'ONE THING AT A TIME'}</span><h2>{active ? active.task : 'Settle into a session'}</h2></div><span className={`small-badge ${active ? 'is-active' : ''}`}>{active ? active.status === 'break' ? 'On a break' : 'Session active' : 'Ready when you are'}</span></div>
            {active ? <>
              <div className="timer-area"><span className="mode-tag">{active.mode}</span><div className="timer" role="timer" aria-label="Elapsed session time">{timer(active.elapsed)}</div><span className={`presence-pill ${data!.state}`}><i />{labels[data!.state]}{data!.state === 'away' ? ' · estimated' : ''}</span></div>
              <div className="session-controls"><button type="button" className="button secondary" disabled={busy || !connected} onClick={() => void action(active.status === 'break' ? 'resume' : 'pause')}>{active.status === 'break' ? 'Resume session' : 'Take a break'}</button><button type="button" className="button primary" disabled={busy || !connected} onClick={() => void action('end')}>{busy ? 'Saving…' : 'End & save session'}<span aria-hidden="true">↗</span></button></div>
              <Timeline session={active} />
            </> : <form onSubmit={start}>
              <label htmlFor="task">What are you working on?</label><input id="task" value={task} onChange={event => setTask(event.target.value)} placeholder="e.g. Linear algebra · Problem set 03" maxLength={200} required autoComplete="off" />
              <div className="form-row"><div><label htmlFor="mode">Study mode</label><select id="mode" value={mode} onChange={event => setMode(event.target.value)}>{['Math', 'Coding', 'Reading', 'Lecture'].map(item => <option key={item}>{item}</option>)}</select></div><div className="camera-choice"><label className="checkbox-label"><input type="checkbox" checked={camera} disabled={busy || !connected} onChange={event => chooseCamera(event.target.checked)} />Use webcam observations</label><p>Face presence & head pose. No video saved.</p>{camera && <button type="button" className="text-button setup-preview-button" disabled={busy || !connected} onClick={openPreview}>Preview camera</button>}</div></div>
              <div className="form-footer"><span>Your session stays on this device.</span><button type="submit" className="button primary" disabled={busy || !connected || !task.trim()}>{busy ? 'Starting…' : 'Start session'}<span aria-hidden="true">→</span></button></div>
            </form>}
          </section>
          <section className="panel history-panel"><div className="panel-heading"><div><span className="eyebrow">A RECORD OF YOUR TIME</span><h2>Session history <span className="count">{history.length}</span></h2></div><span className="muted small">Newest first</span></div>
            {history.length ? <div className="history-list">{history.map(session => <button type="button" className="history-row" key={session.id} onClick={() => setSelected(session)} aria-label={`View ${session.task}`}><span className="session-symbol" aria-hidden="true">{session.mode === 'Math' ? '∑' : session.mode === 'Coding' ? '{}' : session.mode === 'Reading' ? 'Aa' : '↗'}</span><span className="history-text"><strong>{session.task}</strong><span>{session.mode} <b>·</b> {dateLabel(session.started_at)}{session.status === 'interrupted' ? ' · Interrupted' : ''}</span></span><span className="history-duration"><strong>{duration(session.elapsed)}</strong><span>{duration(session.totals.present)} at desk</span></span><span className="row-arrow" aria-hidden="true">↗</span></button>)}</div> : <div className="empty-state"><span className="empty-icon" aria-hidden="true">◷</span><h3>A fresh page for your progress</h3><p>Finish your first session and its timeline<br className="desktop-break" /> will be waiting here.</p></div>}
          </section>
        </div>
        <aside>
          <section className="panel observation-panel"><div className="panel-heading"><div><span className="eyebrow">THE HERE & NOW</span><h2>Observations</h2></div><span className={`camera-status ${cameraStatus}`} role="status">Camera: {cameraStatusLabels[cameraStatus]}</span></div>
            <div className={`observation-visual ${cameraStatus === 'ready' && data?.observation.face_count === 1 ? 'detected' : ''}`} aria-hidden="true"><div className="focus-corners"><span className="observation-glyph">◎</span></div></div>
            <h3 className="observation-title">{cameraStatus === 'starting' ? 'Starting your camera' : cameraStatus === 'unavailable' ? 'Camera unavailable' : cameraStatus === 'ready' ? data?.observation.face_count === 1 ? 'Face detected' : data?.observation.face_count === 0 ? 'Looking for a face' : 'Multiple faces' : active?.status === 'break' ? 'Camera paused' : active ? 'Timer-only session' : 'Your space, your choice'}</h3>
            <p className="observation-message">{cameraMessage}</p>
            <div className="pose-readings">{(['pitch', 'yaw', 'roll'] as const).map(axis => <div key={axis}><span>{axis}</span><strong>{cameraStatus === 'ready' && data && data.observation[axis] != null ? `${data.observation[axis]}°` : '—'}</strong></div>)}</div>
            {observing && <button type="button" className="button secondary show-preview" disabled={busy || !connected || (cameraStatus === 'starting' && previewOpen)} onClick={openPreview}>{cameraStatus === 'unavailable' ? 'Retry camera' : 'Show camera preview'}</button>}
            <p className="footnote">Angles are approximate. Looking down does not mark you as away.</p>
          </section>
          <section className="explanation-card"><span className="eyebrow">WHAT THE TIMELINE TELLS YOU</span><h2>Presence is a starting point.</h2><p>At desk means a face was detected. Away means no face was detected for at least 10 seconds.</p><p>Missing camera data stays unknown. These observations describe your session, not how deeply you were focused.</p><div className="privacy-line"><span aria-hidden="true">◎</span> Local processing. No video recordings.</div></section>
        </aside>
      </div>
      <footer><span>RUFocusing <span aria-hidden="true">/</span> A little time, well understood.</span><span>Saved on your device · SQLite</span></footer>
    </main>
    {previewOpen && <CameraPreview status={cameraStatus} message={cameraMessage} inSession={Boolean(active)} onClose={closePreview} onRetry={openPreview} busy={busy || !connected} />}
    {selected && <SessionDetails session={selected} onClose={() => setSelected(null)} />}
  </>
}
