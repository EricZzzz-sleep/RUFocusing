import { useEffect, useState } from 'react'
import { StudyTotals } from '../../desktop/components/StudyTimeline'
import { duration } from '../../desktop/src/types'
import { modes } from '../../../packages/study'
import { api, type Session } from './api'
import { Link } from './Router'
interface Totals { sessions: number; study: number; deep: number; normal: number; distracted: number; unknown: number; breaks: number }
interface Overview { timezone: string; totals: Totals; days: (Totals & {date: string})[] }
interface History { sessions: Session[]; total: number; page: number; page_size: number }
const periodOptions = { '7': 'Last 7 days', '30': 'Last 30 days', '0': 'All time' }
export default function Analysis({ version, timezone }: { version: number; timezone: string }) {
  const [days, setDays] = useState('7'), [search, setSearch] = useState(''), [query, setQuery] = useState('')
  const [mode, setMode] = useState(''), [status, setStatus] = useState(''), [page, setPage] = useState(0)
  const [overview, setOverview] = useState<Overview | null>(null), [history, setHistory] = useState<History | null>(null)
  const [overviewError, setOverviewError] = useState(''), [historyError, setHistoryError] = useState(''), [retry, setRetry] = useState(0)
  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setPage(0) }, 250); return () => clearTimeout(timer) }, [search])
  useEffect(() => {
    let stale = false; setOverview(null); setOverviewError('')
    api<Overview>(`/overview?days=${days}`).then(result => { if (!stale) setOverview(result) }).catch(e => { if (!stale) setOverviewError(e.message) })
    return () => { stale = true }
  }, [days, version, timezone, retry])
  useEffect(() => {
    let stale = false; setHistory(null); setHistoryError('')
    const params = new URLSearchParams({ days, search: query, mode, status, page: String(page) })
    api<History>(`/history?${params}`).then(result => { if (!stale) { if (page && result.total <= page * 20) setPage(Math.max(0, Math.ceil(result.total / 20) - 1)); else setHistory(result) } }).catch(e => { if (!stale) setHistoryError(e.message) })
    return () => { stale = true }
  }, [days, query, mode, status, page, version, timezone, retry])
  const observed = overview ? overview.totals.deep + overview.totals.normal + overview.totals.distracted : 0
  const coverage = overview?.totals.study ? `${Math.round(observed / overview.totals.study * 100)}%` : '—'
  const max = Math.max(60, ...overview?.days.map(day => day.study) ?? [])
  return <><div className="page-heading"><div><p className="eyebrow">A LITTLE MORE INTENTION</p><h1>Your study overview<span>.</span></h1><p className="intro">Make time for your work. See how each session unfolds.</p></div><Link className="button secondary" href="/record">Record a session →</Link></div>
    <div className="overview-heading"><h2>Your study time</h2><label>Date range<select value={days} onChange={event => { setDays(event.target.value); setPage(0) }}>{Object.entries(periodOptions).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    <div className="web-metrics"><div><span>Total study time</span><strong>{overview ? duration(overview.totals.study) : '—'}</strong></div><div><span>Saved sessions</span><strong>{overview?.totals.sessions ?? '—'}</strong></div><div><span>Tracking coverage</span><strong>{coverage}</strong></div></div>
    <StudyTotals loading={!overview && !overviewError} periods={overview ? { available: observed > 0, intervals: [], totals: overview.totals } : undefined}/>
    {overviewError && <p className="error" role="alert">{overviewError} <button className="text-button" onClick={() => setRetry(n => n + 1)}>Retry overview</button></p>}
    <section className="panel trends-panel"><div className="panel-heading"><h2>Daily study time</h2><span className="muted small">Breaks excluded</span></div>
      <p className="muted">Saved sessions, grouped by start date in {timezone}. Tracking coverage is observed time divided by study time.</p>
      {!overview ? <p role="status">{overviewError ? 'Study totals could not be loaded.' : 'Loading study totals…'}</p> : <>
        {!overview.totals.sessions && <p className="empty-state">Your next saved session will appear here.</p>}
        <div className="chart-legend">{[['deep','Deep study'],['normal','Normal'],['distracted','Distracted'],['unknown','No tracking data']].map(([state,label]) => <span key={state}><i className={`web-${state}`}/>{label}</span>)}</div>
        <div className="chart-scale"><span>Daily duration</span><span>0 – {duration(max)}</span></div>
        <div className="chart-scroll" tabIndex={0} role="region" aria-label="Daily study chart. Scroll for more dates; exact values are in the table below."><div className="daily-chart" style={{ minWidth: Math.max(280, overview.days.length * 38) }} role="img" aria-label="Study time by day: Deep study, Normal, Distracted, and missing tracking data.">{overview.days.map(day => <div className="chart-day" key={day.date} title={`${day.date}: ${duration(day.study)}`}><div className="chart-bar-space"><div className="chart-stack" style={{ height: `${day.study / max * 100}%` }}>{(['deep','normal','distracted','unknown'] as const).map(state => <span key={state} className={`web-${state}`} style={{ height: `${day.study ? day[state] / day.study * 100 : 0}%` }}/>)}</div></div><span className="chart-date">{day.date.slice(5).replace('-','/')}</span></div>)}</div></div>
        <details className="daily-data"><summary>View daily data table</summary><div className="table-scroll"><table><caption>Session counts and durations by start date, in {timezone}</caption><thead><tr>{['Date','Sessions','Study time','Deep study','Normal','Distracted','No tracking','Break'].map(item => <th scope="col" key={item}>{item}</th>)}</tr></thead><tbody>{overview.days.map(day => <tr key={day.date}><th scope="row">{day.date}</th><td>{day.sessions}</td>{(['study','deep','normal','distracted','unknown','breaks'] as const).map(key => <td key={key}>{duration(day[key])}</td>)}</tr>)}</tbody></table></div></details>
      </>}
    </section>
    <section className="panel history-panel"><div className="panel-heading"><h2>Session history</h2><span className="muted small">Newest first</span></div>
      <div className="history-filters"><label>Search tasks<input type="search" value={search} maxLength={200} onChange={event => setSearch(event.target.value)} placeholder="Find a session…"/></label><label>Study mode<select value={mode} onChange={event => { setMode(event.target.value); setPage(0) }}><option value="">All modes</option>{modes.map(value => <option key={value}>{value}</option>)}</select></label><label>Status<select value={status} onChange={event => { setStatus(event.target.value); setPage(0) }}><option value="">All statuses</option><option value="completed">Completed</option><option value="interrupted">Interrupted</option></select></label></div>
      <p className="muted small">Task, mode, and status filters apply to history. The date range applies to the whole overview.</p>
      {(search || mode || status) && <button className="text-button" onClick={() => { setSearch(''); setQuery(''); setMode(''); setStatus(''); setPage(0) }}>Clear history filters</button>}
      {historyError ? <p className="error" role="alert">{historyError} <button className="text-button" onClick={() => setRetry(n => n + 1)}>Retry history</button></p> : !history ? <p role="status">Loading history…</p> : <>
        {!history.sessions.length && <div className="empty-state"><h3>{search || mode || status ? 'No matching sessions' : 'Room for your next session'}</h3><p>Record a session or choose a wider date range.</p></div>}
        <div className="history-list">{history.sessions.map(session => <Link className="history-row" key={session.id} href={`/sessions/${session.id}`}><span className="session-symbol" aria-hidden="true">◷</span><span className="history-text"><strong>{session.task}</strong><span>{session.mode} · {new Date(session.started_at).toLocaleString(undefined, { timeZone: timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric' })}{session.status === 'interrupted' ? ' · Interrupted' : ''}</span></span><span className="history-duration"><strong>{duration(session.elapsed-session.totals.break)}</strong><span>study time</span></span><span aria-hidden="true">↗</span></Link>)}</div>
        <div className="pagination"><button className="button secondary" disabled={!page} onClick={() => setPage(n => n - 1)}>Previous</button><span role="status">{history.total ? `${page * 20 + 1}–${Math.min((page + 1) * 20, history.total)} of ${history.total}` : '0 sessions'}</span><button className="button secondary" disabled={(page+1)*20>=history.total} onClick={() => setPage(n => n + 1)}>Next</button></div>
      </>}
    </section>
  </>
}
