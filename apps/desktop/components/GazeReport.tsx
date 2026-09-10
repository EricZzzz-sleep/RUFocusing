import { useEffect, useState } from 'react'
import { jsonRequest } from '../src/api'
import { duration, gazeRegionLabels } from '../src/types'
import type { GazeDetails, GazeRegion, StudySession } from '../src/types'

export default function GazeReport({ session }: { session: StudySession }) {
  const [details, setDetails] = useState<GazeDetails | null>(null)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!expanded || !session.gaze_summary) return
    let stopped = false
    setError('')
    jsonRequest<GazeDetails>(`/api/sessions/${encodeURIComponent(session.id)}/gaze`)
      .then(next => { if (!stopped) setDetails(next) })
      .catch(() => { if (!stopped) setError('Gaze intervals could not be loaded.') })
    return () => { stopped = true }
  }, [session.id, session.gaze_summary, expanded, attempt])
  const summary = session.gaze_summary
  return <section className="gaze-report" aria-labelledby="gaze-report-title">
    <span className="eyebrow">EXPERIMENTAL · SCREEN GAZE</span><h3 id="gaze-report-title">Where you looked</h3>
    {!summary ? <p className="muted">No gaze data recorded.</p> : <>
      <p className="muted">{summary.coverage == null ? 'N/A' : `${Math.round(summary.coverage * 100)}%`} gaze coverage · {duration(summary.tracked)} with a valid estimate, excluding breaks.</p>
      <dl className="gaze-region-totals">{(Object.keys(gazeRegionLabels) as GazeRegion[]).map(region => <div key={region}><dt>{gazeRegionLabels[region]}</dt><dd>{duration(summary.totals[region] ?? 0)}</dd></div>)}</dl>
      <p className="muted small">Unknown: {duration(summary.totals.unknown ?? 0)}. Uncalibrated time, unreliable observations, and estimates outside the calibrated display remain unknown.</p>
      <details className="interval-details" onToggle={event => setExpanded(event.currentTarget.open)}><summary>View gaze intervals and validation</summary>
        {error ? <p role="alert">{error} <button className="text-button" onClick={() => setAttempt(value => value + 1)}>Retry</button></p> : !details ? <p role="status">Loading gaze intervals…</p> : <>
          {details.calibrations.map(calibration => <p key={calibration.id}>Calibration {calibration.id.slice(0, 8)}: {((calibration.validation.median_error ?? 0) * 100).toFixed(1)}% median / {((calibration.validation.p90_error ?? 0) * 100).toFixed(1)}% p90 error relative to display diagonal.</p>)}
          <div className="table-scroll"><table><thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col">Gaze</th></tr></thead><tbody>{details.intervals.map((interval, index) => <tr key={index}><td>{duration(interval.start)}</td><td>{duration(interval.end)}</td><td>{interval.state === 'unknown' ? 'Unknown' : interval.state === 'break' ? 'Break' : gazeRegionLabels[interval.state]}</td></tr>)}</tbody></table></div>
        </>}
      </details>
    </>}
    <p className="chart-note">These are estimates on one calibrated display, not a measure of mental concentration.</p>
  </section>
}
