import { useState } from 'react'
import { diagnosticDetail } from '../src/diagnostics-api'
import { dateLabel, duration } from '../src/types'
import type { DiagnosticRecord } from '../src/types'

export const percent = (value: number | null | undefined) => value == null ? 'N/A' : `${(value * 100).toFixed(1)}%`
export const reasonLabel = (value: string) => value.replaceAll('_', ' ')

export default function DiagnosticResults({ records }: { records: DiagnosticRecord[] }) {
  const [detail, setDetail] = useState<DiagnosticRecord | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [failedId, setFailedId] = useState<string | null>(null)
  async function show(id: string) {
    setPending(id); setFailedId(id); setError('')
    try { setDetail(await diagnosticDetail(id)) } catch (e) { setError(e instanceof Error ? e.message : 'Could not load diagnostic results.') }
    finally { setPending(null) }
  }
  function download() {
    if (!detail) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = `rufocusing-${detail.kind}-${detail.id}.json`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <div className="diagnostic-results">
    {!records.length ? <p className="muted">No diagnostics recorded yet.</p> : <ul className="diagnostic-list">{records.map(run => <li key={run.id}><button type="button" className="text-button" disabled={pending !== null} onClick={() => void show(run.id)}>{reasonLabel(run.kind)} · {run.status} · {dateLabel(run.created_at)}</button>{pending === run.id && <span role="status"> Loading results…</span>}</li>)}</ul>}
    {error && <p role="alert" className="error">{error} <button type="button" onClick={() => void show(failedId!)}>Retry results</button></p>}
    {detail && <section className="diagnostic-detail" aria-label="Diagnostic result">
      <h3>{reasonLabel(detail.kind)}: {detail.status}</h3>
      <p>{detail.reason ? reasonLabel(detail.reason) : 'Collection in progress'}</p>
      <p>Conditions: {detail.conditions.lighting} lighting · glasses {detail.conditions.glasses} · {detail.conditions.distance} distance</p>
      {detail.conditions.notes && <p>{detail.conditions.notes}</p>}
      <p>Model {detail.model_version} · Protocol {detail.protocol_version}</p>
      <p>Coverage: <strong>{percent(detail.coverage)}</strong> · baseline only, no coverage pass/fail threshold.</p>
      {detail.kind === 'calibration' && detail.validation && <p>Calibration error: {percent(detail.validation.median_error)} median / {percent(detail.validation.p90_error)} p90 of display diagonal.</p>}
      {detail.kind === 'check' && <><p>Measured error: <strong>{percent(detail.median_error)} median / {percent(detail.p90_error)} p90</strong> of display diagonal. {detail.valid_count ?? 0} valid observations.</p><p>Error uses valid estimates only. Incomplete targets cannot establish accuracy.</p></>}
      {detail.rejections && Object.keys(detail.rejections).length > 0 && <p>Rejected observations: {Object.entries(detail.rejections).map(([key, count]) => `${reasonLabel(key)} (${count})`).join(', ')}.</p>}
      <dl className="diagnostic-durations">{Object.entries(detail.durations).map(([key, seconds]) => <div key={key}><dt>{reasonLabel(key)}</dt><dd>{seconds.toFixed(1)}s</dd></div>)}</dl>
      {!!detail.targets.length && <div className="table-scroll" tabIndex={0} role="region" aria-label="Accuracy by target table"><table><caption>Accuracy by target</caption><thead><tr><th>Target</th><th>Valid frames</th><th>Median / p90</th><th>Coverage</th><th>Result</th></tr></thead><tbody>{detail.targets.map(target => <tr key={target.index}><td>{target.index + 1} ({Math.round(target.target[0] * 100)}%, {Math.round(target.target[1] * 100)}%)</td><td>{target.valid_count}</td><td>{percent(target.median_error)} / {percent(target.p90_error)}</td><td>{percent(target.coverage)}</td><td>{target.complete ? 'Complete' : 'Incomplete'}{Object.entries(target.durations).filter(([reason]) => reason !== 'valid').map(([reason, seconds]) => <div key={reason}>{reasonLabel(reason)}: {seconds.toFixed(1)}s</div>)}</td></tr>)}</tbody></table></div>}
      {detail.checkpoints && <><p>Ordinary study measured: {duration(detail.study_seconds ?? 0)}. Breaks and diagnostic windows excluded.</p><ul>{Object.entries(detail.checkpoints).map(([key, checkpoint]) => <li key={key}>{key} check: {checkpoint.status}{checkpoint.study_seconds != null ? ` at ${duration(checkpoint.study_seconds)}` : ''}{checkpoint.check_id && <button type="button" className="text-button" onClick={() => void show(checkpoint.check_id!)}>View check</button>}</li>)}</ul></>}
      {!!detail.buckets?.length && <div className="table-scroll" tabIndex={0} role="region" aria-label="Coverage by period table"><table><caption>Coverage by five-minute study period</caption><thead><tr><th>Period</th><th>Measured</th><th>Coverage</th></tr></thead><tbody>{detail.buckets.map(bucket => <tr key={bucket.index}><td>{bucket.index * 5}–{(bucket.index + 1) * 5} min</td><td>{duration(Object.values(bucket.durations).reduce((sum, value) => sum + value, 0))}</td><td>{percent(bucket.coverage)}</td></tr>)}</tbody></table></div>}
      {!!detail.windows?.length && <details><summary>Diagnostic windows within the trial</summary><ul>{detail.windows.map(window => <li key={window.check_id}>{window.start.toFixed(1)}s–{window.end?.toFixed(1) ?? 'ongoing'}s from trial creation</li>)}</ul></details>}
      <div className="diagnostic-actions"><button className="button secondary" type="button" onClick={download}>Download JSON</button><button className="text-button" type="button" onClick={() => setDetail(null)}>Close result</button></div>
    </section>}
  </div>
}
