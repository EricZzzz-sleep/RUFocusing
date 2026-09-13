import { useId, useState } from 'react'
import type { StudyPeriods, StudyPeriodState, StudySession } from '../src/types'
import { duration, timer } from '../src/types'

export const periodLabels = { deep: 'Deep study', normal: 'Normal', distracted: 'Distracted' } as const
const states = ['deep', 'normal', 'distracted'] as const
const levels: Partial<Record<StudyPeriodState, number>> = { deep: 25, normal: 85, distracted: 145 }
const gapLabels = { break: 'Break', diagnostic: 'Setup', unknown: 'No tracking data' }
export const emptyPeriodTotals = () => ({ deep: 0, normal: 0, distracted: 0 })
export function sumStudyPeriods(sessions: StudySession[]): StudyPeriods {
  return { available: sessions.some(session => session.study_periods?.available), intervals: [],
    totals: sessions.reduce((totals, session) => {
      if (session.study_periods?.available) for (const state of states) totals[state] += session.study_periods.totals[state]
      return totals
    }, emptyPeriodTotals()) }
}

export function StudyTotals({ periods, loading = false }: { periods?: StudyPeriods; loading?: boolean }) {
  return <div className="study-totals" aria-label="Study period totals">{states.map(state => <div key={state} className={`study-total period-${state}`}>
    <span><i aria-hidden="true" />{periodLabels[state]}</span><strong>{loading || !periods?.available ? '—' : duration(periods.totals[state])}</strong>
  </div>)}</div>
}

export default function StudyTimeline({ session }: { session: StudySession }) {
  const id = useId()
  const [selected, setSelected] = useState<number | null>(null)
  const periods = session.study_periods
  const intervals = periods?.intervals ?? []
  const scale = (time: number) => session.elapsed > 0 ? time / session.elapsed * 600 : 0
  const description = (index: number) => {
    const row = intervals[index]
    if (!row) return ''
    const label = row.state in periodLabels ? periodLabels[row.state as keyof typeof periodLabels] : gapLabels[row.state as keyof typeof gapLabels]
    return `${label} · ${timer(row.start)}–${timer(row.end)} · ${duration(row.end - row.start)}`
  }
  return <section className="study-timeline" aria-labelledby={id}>
    <div className="study-chart-heading"><h3 id={id}>Estimated study periods</h3>
      <details className="period-info"><summary aria-label="Study period definitions">ⓘ</summary><p>Deep study: 10+ minutes of continuous presence. Normal: shorter presence. Distracted: detected away time. These are presence-based estimates. Gaps show breaks, setup, or missing data.</p></details>
    </div>
    <StudyTotals periods={periods} />
    {!periods?.available && <p className="chart-empty">No tracking data</p>}
    {session.elapsed > 0 && intervals.length > 0 && <>
      <div className="study-chart">
        <div className="study-axis" aria-hidden="true">{states.map(state => <span key={state}>{periodLabels[state]}</span>)}</div>
        <div className="study-plot">
          <svg viewBox="0 0 600 170" preserveAspectRatio="none" role="group" aria-label="Study periods over elapsed time">
            {states.map(state => <line key={state} x1="0" x2="600" y1={levels[state]} y2={levels[state]} className="study-gridline" />)}
            {intervals.map((row, index) => {
              const y = levels[row.state]
              const previous = intervals[index - 1]
              const previousY = previous ? levels[previous.state] : undefined
              const x = scale(row.start), end = scale(row.end)
              return <g key={`${row.start}-${row.state}`} className={`study-segment period-${row.state}`} role="button" tabIndex={0}
                aria-label={description(index)} aria-pressed={selected === index}
                onMouseEnter={() => setSelected(index)} onFocus={() => setSelected(index)} onClick={() => setSelected(index)}
                onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(index) } }}>
                <title>{description(index)}</title>
                {y === undefined ? <rect x={x} y="8" width={end - x} height="154" className="study-gap" /> : <>
                  {previousY !== undefined && previous.end === row.start && <line x1={x} x2={x} y1={previousY} y2={y} className="study-step" />}
                  <line x1={x} x2={end} y1={y} y2={y} className="study-step" />
                </>}
                <rect x={x} y="0" width={end - x} height="170" className="study-hit" />
              </g>
            })}
          </svg>
          <div className="study-time-axis" aria-hidden="true"><span>0:00</span><span>{timer(session.elapsed / 2)}</span><span>{timer(session.elapsed)}</span></div>
        </div>
      </div>
      <p className="study-tooltip" role="status">{selected === null ? 'Select a period for its time and duration.' : description(selected)}</p>
    </>}
  </section>
}
