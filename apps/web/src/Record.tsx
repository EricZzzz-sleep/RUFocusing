import { useEffect, useState } from 'react'
import StudyTimeline from '../../desktop/components/StudyTimeline'
import { timer } from '../../desktop/src/types'
import { withReport, modes, mergeIntervals } from '../../../packages/study'
import { preference, type Settings } from './api'
import type { SessionController } from './session'
import Camera from './Camera'
import { navigate } from './Router'
export default function Record({ controller: c, settings }: { controller: SessionController; settings: Settings }) {
  const [task, setTask] = useState(''), [mode, setMode] = useState(settings.default_mode)
  const [camera, setCamera] = useState(() => preference('camera-default') === 'true')
  const [, tick] = useState(0)
  useEffect(() => { const interval = setInterval(() => tick(v => v + 1), 250); return () => clearInterval(interval) }, [])
  const active = c.active
  const elapsed = active?.status === 'running' && c.owned && c.connected && !c.retry ? c.elapsed() : active?.elapsed ?? 0
  const preview = active && withReport({ ...active, elapsed, timeline: mergeIntervals([...active.timeline, ...(elapsed > active.elapsed ? c.buffer.snapshot(elapsed).filter(row => row.end > active.elapsed).map(row => ({ ...row, start: Math.max(active.elapsed, row.start) })) : [])]) })
  async function action(name: string, data: Record<string, unknown> = {}) {
    try { const result = await c.command(name, data); if (name === 'end' && result.session) navigate(`/sessions/${result.session.id}`) } catch { /* Controller displays errors and retains retries. */ }
  }
  return <><div className="page-heading"><div><p className="eyebrow">ONE THING AT A TIME</p><h1>Your study session<span>.</span></h1><p className="intro">Choose a task and make time to study.</p></div></div>
    <div className="record-grid"><section className="panel session-panel"><div className="panel-heading"><h2>{active ? active.task : 'Settle into a session'}</h2><span className="small-badge">{active ? active.status === 'break' ? 'Paused' : 'In progress' : 'Ready when you are'}</span></div>
      {!c.loaded ? <p role="status">Loading your session…</p> : active ? <>
        <div className="timer-area"><span className="mode-tag">{active.mode}</span><div className="timer" role="timer" aria-label="Elapsed session time">{timer(elapsed)}</div><p className="timer-note">{active.status === 'break' ? 'Paused time is excluded from study totals.' : 'Live elapsed time · checkpoints saved every 5 seconds.'}</p><p className="muted small">Last saved: {timer(active.elapsed)} elapsed</p></div>
        {active.pause_reason === 'connection_lost' && <p className="notice">Your session paused at its last saved checkpoint after losing contact. Resume when you’re ready.</p>}
        {active.status === 'running' && !c.owned && <p className="notice">This session is recording in another tab. If that tab closed, it will become available to resume after 30 seconds without contact.</p>}
        <div className="session-controls"><button className="button secondary" disabled={c.busy || !c.connected || Boolean(c.retry) || (active.status === 'running' && !c.owned)} onClick={() => void action(active.status === 'break' ? 'resume' : 'pause')}>{active.status === 'break' ? 'Resume session' : 'Take a break'}</button><button className="button primary" disabled={c.busy || !c.connected || Boolean(c.retry) || (active.status === 'running' && !c.owned)} onClick={() => void action('end')}>End & save session ↗</button></div>
        {preview && <StudyTimeline session={preview}/>}<p className="muted small">Unacknowledged time is a live estimate. Saved reports use server checkpoints.</p>
      </> : <form onSubmit={event => { event.preventDefault(); void action('start', { task, mode, camera }) }}>
        <label>What are you working on?<input required maxLength={200} placeholder="e.g. Linear algebra · Problem set 03" value={task} onChange={event => setTask(event.target.value)}/></label>
        <label>Study mode<select value={mode} onChange={event => setMode(event.target.value)}>{modes.map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="checkbox-label"><input type="checkbox" checked={camera} onChange={event => setCamera(event.target.checked)}/>Use camera for presence estimates</label>
        <p className="muted">Without a camera, your timer and history work normally. The timeline shows no tracking data.</p>
        <button className="button primary" disabled={c.busy || !c.connected || Boolean(c.retry) || !task.trim()}>Start session →</button>
      </form>}
    </section>{active ? <Camera controller={c}/> : <aside className="panel quiet-panel"><span className="eyebrow">A LITTLE SPACE TO FOCUS</span><h2>One task.<br/>Your own pace.</h2><p>Take breaks whenever you need. Your saved timeline will help you see how each session unfolded.</p><p className="muted">Closing the tab or losing contact pauses the session at its last saved checkpoint. Resume when you return.</p></aside>}</div>
  </>
}
