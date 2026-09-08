import { duration, labels } from '../src/types'
import type { Presence, StudySession } from '../src/types'

export default function Timeline({ session }: { session: StudySession }) {
  return <section className="timeline-section" aria-label="Session timeline">
    <div className="section-label"><h3>Session timeline</h3><span>{duration(session.elapsed)} total</span></div>
    <div className="timeline-track" role="img" aria-label={Object.entries(session.totals).map(([key, value]) => `${labels[key as Presence]}: ${duration(value)}`).join(', ')}>
      {session.timeline.map((interval, index) => <span key={index} className={`segment ${interval.state}`} style={{ width: `${session.elapsed ? (interval.end - interval.start) / session.elapsed * 100 : 0}%` }} title={`${labels[interval.state]} · ${duration(interval.start)} to ${duration(interval.end)}`} />)}
    </div>
    <div className="timeline-ends"><span>Start</span><span>{session.status === 'running' || session.status === 'break' ? 'Now' : 'End'}</span></div>
    <div className="legend">{Object.entries(labels).map(([key, label]) => <div key={key}><i className={key} /><span>{label}</span><strong>{duration(session.totals[key as Presence])}</strong></div>)}</div>
    {session.timeline.length > 0 && <details className="interval-details"><summary>View time intervals</summary><div className="table-scroll"><table><thead><tr><th>From</th><th>To</th><th>Observation</th></tr></thead><tbody>{session.timeline.map((item, index) => <tr key={index}><td>{duration(item.start)}</td><td>{duration(item.end)}</td><td>{labels[item.state]}</td></tr>)}</tbody></table></div></details>}
  </section>
}
