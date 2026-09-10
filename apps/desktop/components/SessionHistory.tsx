import { useState } from 'react'
import type { StudySession } from '../src/types'
import { dateLabel, duration, studyModes } from '../src/types'
import { filterHistory, studyTime } from '../src/analysis'

export default function SessionHistory({ sessions, loading, onSelect }: { sessions: StudySession[]; loading: boolean; onSelect: (session: StudySession) => void }) {
  const [search, setSearch] = useState('')
  const [mode, setMode] = useState('')
  const [status, setStatus] = useState('')
  const history = filterHistory(sessions, search, mode, status)
  const filtered = Boolean(search || mode || status)
  return <section className="panel history-panel" aria-labelledby="history-title">
    <div className="panel-heading"><div><span className="eyebrow">A RECORD OF YOUR TIME</span><h2 id="history-title">Session history <span className="count">{history.length}</span></h2></div><span className="muted small">Newest first</span></div>
    <div className="history-filters">
      <div className="history-search"><label htmlFor="history-search">Search tasks</label><input id="history-search" type="search" placeholder="Find a session…" value={search} onChange={event => setSearch(event.target.value)} /></div>
      <div><label htmlFor="history-mode">Study mode</label><select id="history-mode" value={mode} onChange={event => setMode(event.target.value)}><option value="">All modes</option>{studyModes.map(item => <option key={item}>{item}</option>)}</select></div>
      <div><label htmlFor="history-status">Status</label><select id="history-status" value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option><option value="completed">Completed</option><option value="interrupted">Interrupted</option></select></div>
    </div>
    <div className="history-results"><span role="status">{loading ? 'Loading history…' : `${history.length} of ${sessions.length} sessions in this period`}</span>{filtered && <button type="button" className="text-button" onClick={() => { setSearch(''); setMode(''); setStatus('') }}>Clear history filters</button>}</div>
    {history.length ? <div className="history-list">{history.map(session => <button type="button" className="history-row" key={session.id} onClick={() => onSelect(session)} aria-label={`View ${session.task}`}><span className="session-symbol" aria-hidden="true">{session.mode === 'Math' ? '∑' : session.mode === 'Coding' ? '{}' : session.mode === 'Reading' ? 'Aa' : '↗'}</span><span className="history-text"><strong>{session.task}</strong><span>{session.mode} <b>·</b> {dateLabel(session.started_at)}{session.status === 'interrupted' ? ' · Interrupted' : ''}</span></span><span className="history-duration"><strong>{duration(studyTime(session))}</strong><span>study time</span></span><span className="row-arrow" aria-hidden="true">↗</span></button>)}</div> : !loading && <div className="empty-state"><span className="empty-icon" aria-hidden="true">◷</span><h3>{filtered ? 'No matching sessions' : 'Room for your next session'}</h3><p>{filtered ? 'Try another task, mode, or status.' : 'Finish a session or choose a wider date range to see your history.'}</p></div>}
  </section>
}
