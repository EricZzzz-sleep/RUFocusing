import { useEffect, useRef, useState } from 'react'
import { jsonRequest } from '../src/api'
import type { AnnotationKind, Reflection, SessionAnalysis, StudyAnnotation, StudySession } from '../src/types'
import { duration, timer } from '../src/types'
import { annotationLabels, parseOffset } from '../src/study-patterns'

const emptyReflection: Reflection = { concentration: null, distraction: null, flow: null }

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
  const draftStart = parseOffset(start), draftEnd = parseOffset(end)
  const validPreview = draftStart !== null && draftEnd !== null && draftStart < draftEnd && draftEnd <= session.elapsed
  return <section className="study-report" aria-labelledby="study-report-title">
    <h3 id="study-report-title">Your reflection</h3>
    <form className="reflection-form" onSubmit={event => { event.preventDefault(); void save('reflection') }}>
      <fieldset disabled={pending !== null}>
        <legend>Optional personal reflection</legend>
        <p id="reflection-help" className="muted">Optional. Edit or clear your answers anytime.</p>
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
        <p className="muted" id="flow-help">Did you feel absorbed in your work?</p>
        <button className="button primary" type="submit">{pending === 'reflection' ? 'Saving reflection…' : 'Save reflection'}</button>
      </fieldset>
      {errors.reflection && <p role="alert">{errors.reflection}</p>}<p className="save-feedback" role="status">{messages.reflection}</p>
    </form>
    <form className="annotation-form" onSubmit={event => { event.preventDefault(); addTag() }}>
      <fieldset disabled={pending !== null}>
        <legend>Optional personal timeline tags</legend>
        <p id="tag-help" className="muted">Use HH:MM:SS, up to {timer(session.elapsed)}. Tags cannot overlap or include breaks or setup.</p>
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
