import { useEffect, useRef } from 'react'
import type { StudySession } from '../src/types'
import { dateLabel, duration } from '../src/types'
import Timeline from './Timeline'
import GazeReport from './GazeReport'
import { coverage, studyTime } from '../src/analysis'

export default function SessionDetails({ session, onClose }: { session: StudySession; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    const previousFocus = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    dialog.showModal()
    document.body.style.overflow = 'hidden'
    return () => { dialog.close(); document.body.style.overflow = overflow; if (previousFocus?.isConnected) previousFocus.focus(); else document.querySelector<HTMLInputElement>('#task')?.focus() }
  }, [])
  const observed = session.totals.present + session.totals.away
  const active = studyTime(session)
  const metrics = [
    ['Total session time', duration(session.elapsed)], ['Study time', duration(active)],
    ['Break time', duration(session.totals.break)], ['At-desk time', duration(session.totals.present)],
    ['Estimated away', duration(session.totals.away)], ['Unknown time', duration(session.totals.unknown)],
    ['Longest at-desk period', duration(session.longest_present)], ['Observation coverage', coverage(observed, active)],
  ]
  return <dialog ref={ref} className="session-dialog" aria-labelledby="detail-title" onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose() } }}>
    <div className="detail-top"><span className="eyebrow">SESSION SUMMARY</span><button type="button" className="icon-button" onClick={onClose} aria-label="Close session details" autoFocus>×</button></div>
    <span className="mode-tag">{session.mode}</span>
    <h2 id="detail-title">{session.task}</h2>
    <p className="muted">{dateLabel(session.started_at)} · {session.status === 'interrupted' ? 'Interrupted' : 'Completed'}</p>
    {session.status === 'interrupted' && <p className="notice">This session ended at its last saved checkpoint when the app stopped.</p>}
    <div className="detail-metrics">{metrics.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <Timeline session={session} />
    <GazeReport session={session} />
    <div className="conclusion"><span className="eyebrow">YOUR SESSION, SUMMED UP</span><p>{observed ? `${duration(session.totals.present)} with a face detected and ${duration(session.totals.away)} estimated away.` : 'No presence observations were available for this session.'}</p><span>{coverage(observed, active)} observation coverage: at-desk and away time divided by study time, excluding breaks. Unknown includes camera-off time and unreliable observations. Presence is not a measure of focus.</span></div>
  </dialog>
}
