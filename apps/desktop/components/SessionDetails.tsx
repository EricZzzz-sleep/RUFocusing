import { useEffect, useRef, useState } from 'react'
import type { StudySession } from '../src/types'
import { dateLabel, duration } from '../src/types'
import StudyTimeline from './StudyTimeline'
import StudyPatternReport from './StudyPatternReport'
import { studyTime } from '../src/analysis'

export default function SessionDetails({ session, onClose }: { session: StudySession; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [reflectionOpen, setReflectionOpen] = useState(false)
  useEffect(() => {
    const dialog = ref.current!
    const previousFocus = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    dialog.showModal()
    document.body.style.overflow = 'hidden'
    return () => { dialog.close(); document.body.style.overflow = overflow; if (previousFocus?.isConnected && !previousFocus.closest('[hidden]')) previousFocus.focus(); else document.querySelector<HTMLElement>('h1')?.focus() }
  }, [])
  return <dialog ref={ref} className="session-dialog" aria-labelledby="detail-title" onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose() } }}>
    <div className="detail-top"><span className="eyebrow">SESSION SUMMARY</span><button type="button" className="icon-button" onClick={onClose} aria-label="Close session details" autoFocus>×</button></div>
    <span className="mode-tag">{session.mode}</span>
    <h2 id="detail-title">{session.task}</h2>
    <p className="muted">{dateLabel(session.started_at)} · {session.status === 'interrupted' ? 'Interrupted' : 'Completed'}</p>
    {session.status === 'interrupted' && <p className="notice">This session ended at its last saved checkpoint when the app stopped.</p>}
    <p className="session-study-duration">{duration(studyTime(session))} study time</p>
    <StudyTimeline session={session} />
    <details className="reflection-details" onToggle={event => { if (event.currentTarget.open) setReflectionOpen(true) }}><summary>Reflection</summary>
      {reflectionOpen && <StudyPatternReport key={session.id} session={session} />}
    </details>
  </dialog>
}
