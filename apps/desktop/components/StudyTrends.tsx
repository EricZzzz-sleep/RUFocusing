import type { DailyStudy } from '../src/analysis'
import { coverage } from '../src/analysis'
import { duration, labels } from '../src/types'

const states = ['present', 'away', 'unknown'] as const

// Chart contract: compare daily study duration and observed composition, using
// saved sessions grouped by local start date. Stacked bars start at zero; the
// existing presence palette, ordered stacks, and a full table distinguish states.
// Empty dates are zero, not fabricated observations. React owns this app surface.
export default function StudyTrends({ days, loading }: { days: DailyStudy[]; loading: boolean }) {
  const maximum = Math.max(60, ...days.map(day => day.study))
  const hasStudy = days.some(day => day.study > 0)
  return <section className="panel trends-panel" aria-labelledby="trends-title">
    <div className="panel-heading"><div><span className="eyebrow">MAKE YOUR TIME VISIBLE</span><h2 id="trends-title">Daily study time</h2></div><span className="muted small">Breaks excluded</span></div>
    <div className="trends-body">
      <p className="chart-context">{days[0]?.label} – {days.at(-1)?.label}. Saved sessions, grouped by local start date.</p>
      {loading ? <p className="chart-empty" role="status">Loading your study history…</p> : <>
        <div className="chart-legend">{states.map(state => <span key={state}><i className={state} />{labels[state]}</span>)}</div>
        {!hasStudy && <p className="chart-empty">No study time saved in this period. Your next session will appear here.</p>}
        <div className="chart-scale" aria-hidden="true"><span>Daily duration</span><span>Scale: 0 – {duration(maximum)}</span></div>
        <div className="chart-scroll" tabIndex={0} role="region" aria-label="Daily study chart; scroll horizontally for more dates. Exact values are in the table below.">
          <div className="daily-chart" style={{ minWidth: `${Math.max(280, days.length * 40)}px` }} role="img" aria-label={`Daily study time, ${days.length} days. Stacks show at desk, away, and unknown. Use the daily data table for exact durations.`}>
            {days.map(day => <div className="chart-day" key={day.date} title={`${day.label}: ${duration(day.study)} study; ${duration(day.present)} at desk, ${duration(day.away)} away, ${duration(day.unknown)} unknown`}>
              <div className="chart-bar-space"><div className="chart-stack" style={{ height: `${day.study / maximum * 100}%` }}>{states.map(state => <span key={state} className={state} style={{ height: `${day.study ? day[state] / day.study * 100 : 0}%` }} />)}</div></div>
              <span className="chart-date">{day.date.slice(5).replace('-', '/')}</span>
            </div>)}
          </div>
        </div>
        <details className="interval-details daily-data"><summary>View daily data table</summary><div className="table-scroll"><table><caption>Saved study sessions by local start date. All durations exclude breaks except the Break column.</caption><thead><tr>{['Date', 'Sessions', 'Study time', 'At desk', 'Away', 'Unknown', 'Break', 'Coverage'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{days.map(day => <tr key={day.date}><th scope="row">{day.label}</th><td>{day.sessions}</td><td>{duration(day.study)}</td><td>{duration(day.present)}</td><td>{duration(day.away)}</td><td>{duration(day.unknown)}</td><td>{duration(day.breaks)}</td><td>{coverage(day.present + day.away, day.study)}</td></tr>)}</tbody></table></div></details>
      </>}
      <p className="chart-note">At desk and away are presence estimates. Unknown includes time with the camera off or without reliable observations.</p>
    </div>
  </section>
}
