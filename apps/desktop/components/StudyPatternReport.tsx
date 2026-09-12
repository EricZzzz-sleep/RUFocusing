import { useEffect, useRef, useState } from 'react'
import { jsonRequest } from '../src/api'
import type { AnnotationKind, Reflection, SessionAnalysis, StudyAnnotation, StudySession } from '../src/types'
import { duration, labels, timer } from '../src/types'
import { annotationLabels, availabilityReasons, parseOffset } from '../src/study-patterns'

const emptyReflection: Reflection = { concentration: null, distraction: null, flow: null }
const evidenceLabel = (state: string) => state === 'diagnostic' ? 'Diagnostic · excluded' : labels[state as keyof typeof labels]

export default function StudyPatternReport({ session }: { session: StudySession }) {
  const [analysis, setAnalysis] = useState<SessionAnalysis | null>(null)
  const [reflection, setReflection] = useState<Reflection>(emptyReflection)
  const [annotations, setAnnotations] = useState<StudyAnnotation[]>([])
  const [loadingError, setLoadingError] = useState('')
  const [retry, setRetry] = useState(0)
  const [pending, setPending] = useState<'reflection' | 'annotations' | null>(null)
  const [messages, setMessages] = useState({ reflection: '', annotations: '' })
  const [errors, setErrors] = useState({ reflection: '', annotations: '' })
  const [start, setStart] = useState('00:00:00')
  const [end, setEnd] = useState('00:00:00')
  const [kind, setKind] = useState<AnnotationKind>('focused')
  const [editing, setEditing] = useState<number | null>(null)
  const [tagError, setTagError] = useState('')
  const busy = useRef(false)
  const alive = useRef(false)
  const startInput = useRef<HTMLInputElement>(null)
  const path = `/api/sessions/${encodeURIComponent(session.id)}`
  useEffect(() => {
    let stopped = false
    alive.current = true
    setLoadingError('')
    void jsonRequest<SessionAnalysis>(`${path}/analysis`).then(result => {
      if (!stopped) { setAnalysis(result); setReflection(result.reflection); setAnnotations(result.annotations) }
    }).catch(() => { if (!stopped) setLoadingError('Study patterns could not be loaded. Your saved session is safe.') })
    return () => { stopped = true; alive.current = false }
  }, [path, retry])

  async function save(action: 'reflection' | 'annotations') {
    if (busy.current) return
    busy.current = true; setPending(action)
    setErrors(value => ({ ...value, [action]: '' })); setMessages(value => ({ ...value, [action]: '' }))
    try {
      const result = await jsonRequest<SessionAnalysis>(`${path}/${action}`, action === 'reflection' ? reflection : { annotations })
      if (alive.current) { setAnalysis(result); setMessages(value => ({ ...value, [action]: action === 'reflection' ? 'Reflection saved.' : 'Timeline tags saved.' })) }
    } catch (error) {
      if (alive.current) setErrors(value => ({ ...value, [action]: `${error instanceof Error ? error.message : 'Could not save.'} Your entries are still here; retry saving. The session is already saved.` }))
    } finally { busy.current = false; if (alive.current) setPending(null) }
  }

  function addTag() {
    const a = parseOffset(start), b = parseOffset(end)
    if (a === null || b === null || a >= b || b > session.elapsed) { setTagError(`Use HH:MM:SS times with start before end, between 00:00:00 and ${timer(session.elapsed)}.`); return }
    const blocked = [...session.timeline.filter(row => row.state === 'break'), ...(analysis?.exclusions ?? [])]
    if (blocked.some(row => a < row.end && b > row.start)) { setTagError('Tags cannot overlap breaks or recorded diagnostic windows.'); return }
    if (annotations.some((row, index) => index !== editing && a < row.end && b > row.start)) { setTagError('Tags cannot overlap one another.'); return }
    if (editing === null && annotations.length >= 30) { setTagError('You can save up to 30 tags per session.'); return }
    setAnnotations([...annotations.filter((_, index) => index !== editing), { start: a, end: b, kind }].sort((x, y) => x.start - y.start))
    setEditing(null); setTagError(''); setMessages(value => ({ ...value, annotations: 'Tag list changed. Select Save timeline tags to keep your changes.' })); startInput.current?.focus()
  }

  if (loadingError) return <section className="study-report"><p role="alert">{loadingError}</p><button type="button" className="button secondary" onClick={() => setRetry(value => value + 1)}>Retry study patterns</button></section>
  if (!analysis) return <p role="status">Loading study patterns…</p>
  const summary = analysis.summary
  const metric = (value: number | null) => value === null ? 'N/A' : duration(value)
  const rating = (value: number | null) => value === null ? 'N/A' : `${value} / 5`
  const flow = summary.reflection.flow === null ? 'N/A' : summary.reflection.flow === 'yes' ? 'Yes' : summary.reflection.flow === 'no' ? 'No' : 'Unsure'
  const draftStart = parseOffset(start), draftEnd = parseOffset(end)
  const validPreview = draftStart !== null && draftEnd !== null && draftStart < draftEnd && draftEnd <= session.elapsed
  return <section className="study-report" aria-labelledby="study-report-title">
    <h3 id="study-report-title">Study patterns & reflection</h3>
    <div className="pattern-metrics">
      <div><span>Observed · sustained at desk</span><strong>{summary.sustained_count === null ? 'N/A' : `${summary.sustained_count} ${summary.sustained_count === 1 ? 'period' : 'periods'}`}</strong><small>{metric(summary.sustained_seconds)} total · longest {metric(summary.longest_sustained)}</small></div>
      <div><span>Observed · possible interruptions</span><strong>{summary.interruption_count === null ? 'N/A' : `${summary.interruption_count} ${summary.interruption_count === 1 ? 'episode' : 'episodes'}`}</strong><small>{metric(summary.interruption_seconds)} recorded away; cause unknown</small></div>
      <div><span>Observed · presence coverage</span><strong>{summary.observation_coverage === null ? 'N/A' : `${Math.round(summary.observation_coverage * 100)}%`}</strong><small>Breaks and diagnostics excluded; unknown study time stays in the denominator.</small></div>
      <div><span>Personal · saved ratings</span><strong>Concentration {rating(summary.reflection.concentration)}</strong><small>Distraction frequency {rating(summary.reflection.distraction)}<br />Self-reported flow: {flow}</small></div>
    </div>
    {summary.availability.reasons.map(reason => <p className="notice" key={reason}>{availabilityReasons[reason] ?? reason}</p>)}
    <p className="muted">A sustained at-desk period is at least 10 uninterrupted minutes of recorded presence. This product default does not establish deep concentration. Away episodes indicate possible interruptions, without identifying their cause.</p>
    <h4>Evidence timeline</h4>
    <p className="muted">Recorded observations and personal tags are separate layers. Gaze movement, looking down, and reading paper are never automatically labeled distraction or flow.</p>
    <div className="evidence-track" role="img" aria-label="Recorded presence timeline; exact times are in the evidence table below.">
      {analysis.intervals.map((row, index) => <span key={index} className={`evidence-${row.state}`} style={{ width: `${session.elapsed ? (row.end - row.start) / session.elapsed * 100 : 0}%` }} />)}
    </div>
    <div className="tag-track" role="img" aria-label="Draft self-reported timeline tags; exact times are listed below.">
      {annotations.map((row, index) => <span key={index} className={`tag-${row.kind}`} style={{ left: `${row.start / session.elapsed * 100}%`, width: `${(row.end - row.start) / session.elapsed * 100}%` }} />)}
    </div>
    <div className="evidence-legend"><span>Recorded:</span>{['present', 'away', 'unknown', 'break', 'diagnostic'].map(state => <span key={state}><i className={`evidence-${state}`} aria-hidden="true" />{evidenceLabel(state)}</span>)}</div>
    <div className="evidence-legend"><span>Personal:</span>{Object.entries(annotationLabels).map(([key, label]) => <span key={key}><i className={`tag-${key}`} aria-hidden="true" />{label}</span>)}</div>
    <details><summary>Recorded evidence and exclusion times</summary><div className="evidence-table" tabIndex={0} role="region" aria-label="Recorded evidence intervals">
      <table><thead><tr><th>Start</th><th>End</th><th>Duration</th><th>Recorded evidence</th></tr></thead><tbody>
        {analysis.intervals.map((row, index) => <tr key={index}><td>{timer(row.start)}</td><td>{timer(row.end)}</td><td>{duration(row.end - row.start)}</td><td>{evidenceLabel(row.state)}{analysis.sustained_periods.some(period => period.start === row.start && period.end === row.end) && ' · sustained at desk'}</td></tr>)}
      </tbody></table>{!analysis.intervals.length && <p>No recorded time in this session.</p>}
    </div>{analysis.exclusions.map(row => <p key={row.run_id}>{row.kind === 'calibration' ? 'Calibration' : 'Accuracy check'} excluded: {timer(row.start)}–{timer(row.end)}.</p>)}</details>
    <form className="reflection-form" onSubmit={event => { event.preventDefault(); void save('reflection') }}>
      <fieldset disabled={pending !== null}>
        <legend>Optional personal reflection</legend>
        <p id="reflection-help" className="muted">Skip, edit, or clear any answer. Ratings describe your whole session, not individual minutes.</p>
        <div className="reflection-fields">
          <label>Concentration<select aria-label="Concentration" aria-describedby="reflection-help" value={reflection.concentration ?? ''} onChange={event => setReflection(value => ({ ...value, concentration: event.target.value ? Number(event.target.value) : null }))}>
            <option value="">Skipped / clear answer</option>{[1, 2, 3, 4, 5].map(value => <option value={value} key={value}>{value}{value === 1 ? ' — Very low' : value === 5 ? ' — Very high' : ''}</option>)}
          </select></label>
          <label>Distraction frequency<select aria-label="Distraction frequency" aria-describedby="reflection-help" value={reflection.distraction ?? ''} onChange={event => setReflection(value => ({ ...value, distraction: event.target.value ? Number(event.target.value) : null }))}>
            <option value="">Skipped / clear answer</option>{[1, 2, 3, 4, 5].map(value => <option value={value} key={value}>{value}{value === 1 ? ' — Rarely' : value === 5 ? ' — Very often' : ''}</option>)}
          </select></label>
          <label>Self-reported flow<select aria-label="Self-reported flow" aria-describedby="flow-help" value={reflection.flow ?? ''} onChange={event => setReflection(value => ({ ...value, flow: (event.target.value || null) as Reflection['flow'] }))}>
            <option value="">Skipped / clear answer</option><option value="yes">Yes</option><option value="no">No</option><option value="unsure">Unsure</option>
          </select></label>
        </div>
        <p className="muted" id="flow-help">Did you feel absorbed and work smoothly? This is your reported experience, not a validated psychological scale or a camera assessment.</p>
        <button className="button primary" type="submit">{pending === 'reflection' ? 'Saving reflection…' : 'Save reflection'}</button>
      </fieldset>
      {errors.reflection && <p role="alert">{errors.reflection}</p>}<p className="save-feedback" role="status">{messages.reflection}</p>
    </form>
    <form className="annotation-form" onSubmit={event => { event.preventDefault(); addTag() }}>
      <fieldset disabled={pending !== null}>
        <legend>Optional personal timeline tags</legend>
        <p id="tag-help" className="muted">Use elapsed HH:MM:SS times, up to {timer(session.elapsed)}. Tags cannot overlap each other, breaks, or known diagnostics. You may tag unknown camera time; its observation remains unknown.</p>
        <div className="tag-fields">
          <label>Tag<select aria-label="Tag" value={kind} onChange={event => setKind(event.target.value as AnnotationKind)}>{Object.entries(annotationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>Start time<input ref={startInput} aria-describedby="tag-help" value={start} onChange={event => setStart(event.target.value)} placeholder="HH:MM:SS" /></label>
          <label>End time<input aria-describedby="tag-help" value={end} onChange={event => setEnd(event.target.value)} placeholder="HH:MM:SS" /></label>
        </div>
        <div className="tag-track draft-preview" role="img" aria-label={validPreview ? `Tag preview: ${annotationLabels[kind]}, ${start} to ${end}.` : 'Enter a valid start and end to preview a tag.'}>
          {validPreview && <span className={`tag-${kind}`} style={{ left: `${draftStart! / session.elapsed * 100}%`, width: `${(draftEnd! - draftStart!) / session.elapsed * 100}%` }} />}
        </div>{tagError && <p role="alert">{tagError}</p>}
        <div className="tag-actions"><button type="submit" className="button secondary">{editing === null ? 'Add tag to list' : 'Update tag in list'}</button>{editing !== null && <button type="button" className="button secondary" onClick={() => { setEditing(null); setTagError(''); startInput.current?.focus() }}>Cancel tag edit</button>}</div>
        <ul className="annotation-list">{annotations.map((row, index) => <li key={`${row.start}-${row.end}`}>
          <div><strong>{annotationLabels[row.kind]}</strong> · {timer(row.start)}–{timer(row.end)} · {duration(row.end - row.start)}{row.kind !== 'distracted' && row.end - row.start >= analysis.threshold_seconds && <small>Self-reported sustained focus</small>}</div>
          <div className="tag-actions"><button type="button" className="button secondary" aria-label={`Edit ${annotationLabels[row.kind]} tag starting ${timer(row.start)}`} onClick={() => { setEditing(index); setStart(timer(row.start)); setEnd(timer(row.end)); setKind(row.kind); setTagError(''); startInput.current?.focus() }}>Edit</button>
            <button type="button" className="button secondary" aria-label={`Delete ${annotationLabels[row.kind]} tag starting ${timer(row.start)}`} onClick={() => { setAnnotations(value => value.filter((_, i) => i !== index)); setEditing(null); setMessages(value => ({ ...value, annotations: 'Tag removed from the list. Save timeline tags to keep this change.' })); startInput.current?.focus() }}>Delete</button></div>
        </li>)}</ul>
        {!annotations.length && <p className="muted">No personal timeline tags.</p>}
        <button type="button" className="button primary" disabled={editing !== null} onClick={() => void save('annotations')}>{pending === 'annotations' ? 'Saving timeline tags…' : 'Save timeline tags'}</button>
      </fieldset>{errors.annotations && <p role="alert">{errors.annotations}</p>}<p className="save-feedback" role="status">{messages.annotations}</p>
    </form>
    <p>Saved tagged time: Focused {duration(summary.tagged_seconds.focused)} · Distracted {duration(summary.tagged_seconds.distracted)} · Flow {duration(summary.tagged_seconds.flow)}.</p>
    <p className="muted">Self-reported sustained focus: {duration(summary.self_reported_sustained_seconds)}, from individual Focused or Flow tags of at least 10 minutes.</p>
  </section>
}
