/** Pure calculations shared by the browser and the hosted report API. */
export type Presence = 'present' | 'away' | 'unknown' | 'break'
export interface Interval { start: number; end: number; state: Presence }
export interface Reflection { concentration: number | null; distraction: number | null; flow: 'yes' | 'no' | 'unsure' | null }
export interface Annotation { start: number; end: number; kind: 'focused' | 'distracted' | 'flow' }
export interface CloudSession {
  id: string; task: string; mode: string; started_at: string; ended_at: string | null
  status: 'running' | 'break' | 'completed' | 'interrupted'; elapsed: number
  camera_enabled: boolean; revision: number; checkpoint_at: string; lease_until: string | null
  owner_tab: string | null; pause_reason: string | null; timeline: Interval[]
  reflection: Reflection; annotations: Annotation[]
}
export const modes = ['Math', 'Coding', 'Reading', 'Lecture'] as const
export const emptyReflection = (): Reflection => ({ concentration: null, distraction: null, flow: null })
export function mergeIntervals(rows: Interval[]): Interval[] {
  const result: Interval[] = []
  for (const row of rows) {
    if (row.end <= row.start) continue
    const last = result.at(-1)
    if (last?.state === row.state && Math.abs(last.end - row.start) < 0.000001) last.end = row.end
    else result.push({ ...row })
  }
  return result
}
export function normalizeTimeline(rows: Interval[], elapsed: number): Interval[] {
  const events = new Map<number, {state: Presence; change: number}[]>([[0, []], [elapsed, []]])
  for (const row of rows) {
    const start = Math.max(0, Math.min(elapsed, row.start)), end = Math.max(0, Math.min(elapsed, row.end))
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    events.set(start, [...(events.get(start) ?? []), {state: row.state, change: 1}])
    events.set(end, [...(events.get(end) ?? []), {state: row.state, change: -1}])
  }
  const bounds = [...events.keys()].sort((a,b) => a-b), counts = new Map<Presence,number>(), result: Interval[] = []
  for (let index=0; index<bounds.length-1; index++) {
    const start = bounds[index], end = bounds[index+1]
    for (const event of events.get(start)!) { const count = (counts.get(event.state) ?? 0) + event.change; if (count) counts.set(event.state,count); else counts.delete(event.state) }
    const total = [...counts.values()].reduce((sum,count) => sum+count,0)
    result.push({start,end,state: total === 1 ? counts.keys().next().value! : 'unknown'})
  }
  return mergeIntervals(result)
}
export function studyReport(session: Pick<CloudSession, 'id' | 'elapsed' | 'timeline' | 'reflection' | 'annotations'>) {
  const intervals = normalizeTimeline(session.timeline, session.elapsed)
  const totals = { present: 0, away: 0, unknown: 0, break: 0 }
  for (const row of intervals) totals[row.state] += row.end - row.start
  const observed = totals.present + totals.away, eligible = Math.max(0, session.elapsed - totals.break)
  const available = observed > 0
  const sustained = intervals.filter(row => row.state === 'present' && row.end - row.start >= 600)
  const interruptions = intervals.filter(row => row.state === 'away')
  const total = (rows: {start: number; end: number}[]) => rows.reduce((sum, row) => sum + row.end - row.start, 0)
  const tagged = { focused: 0, distracted: 0, flow: 0 }
  for (const row of session.annotations) tagged[row.kind] += row.end - row.start
  const periodIntervals = intervals.map(row => ({ ...row, state: row.state === 'present' ? (row.end - row.start >= 600 ? 'deep' : 'normal') as 'deep' | 'normal' : row.state === 'away' ? 'distracted' as const : row.state }))
  const periodTotals = { deep: 0, normal: 0, distracted: 0 }
  for (const row of periodIntervals) if (row.state === 'deep' || row.state === 'normal' || row.state === 'distracted') periodTotals[row.state] += row.end - row.start
  const summary = {
    version: 'study-patterns-v1', availability: { available, reasons: available ? [] : [eligible ? 'no_presence_observations' : 'no_eligible_study_time'] },
    sustained_count: available ? sustained.length : null, sustained_seconds: available ? total(sustained) : null,
    longest_sustained: available ? Math.max(0, ...sustained.map(row => row.end - row.start)) : null,
    interruption_count: available ? interruptions.length : null, interruption_seconds: available ? total(interruptions) : null,
    eligible_seconds: eligible, observed_seconds: observed, observation_coverage: eligible ? observed / eligible : null,
    tagged_seconds: tagged, self_reported_sustained_seconds: total(session.annotations.filter(row => row.kind !== 'distracted' && row.end - row.start >= 600)),
    reflection: session.reflection,
  }
  return { session_id: session.id, summary, threshold_seconds: 600, intervals, sustained_periods: sustained,
    interruptions, exclusions: [], reflection: session.reflection, annotations: session.annotations,
    study_periods: { available, intervals: periodIntervals, totals: periodTotals }, totals,
    longest_present: Math.max(0, ...intervals.filter(row => row.state === 'present').map(row => row.end - row.start)) }
}
export function withReport(session: CloudSession) {
  const report = studyReport(session)
  return { ...session, totals: report.totals, study_periods: report.study_periods, longest_present: report.longest_present, analysis_summary: report.summary }
}
export function validateReflection(value: unknown): Reflection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid reflection.')
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !['concentration', 'distraction', 'flow'].includes(key))) throw new Error('Invalid reflection field.')
  for (const key of ['concentration', 'distraction']) if (row[key] != null && (!Number.isInteger(row[key]) || Number(row[key]) < 1 || Number(row[key]) > 5)) throw new Error('Ratings must be whole numbers from 1 to 5.')
  if (row.flow != null && !['yes', 'no', 'unsure'].includes(String(row.flow))) throw new Error('Invalid flow rating.')
  return { concentration: row.concentration == null ? null : Number(row.concentration), distraction: row.distraction == null ? null : Number(row.distraction), flow: (row.flow ?? null) as Reflection['flow'] }
}
export function validateAnnotations(value: unknown, session: Pick<CloudSession, 'elapsed' | 'timeline'>): Annotation[] {
  if (!Array.isArray(value) || value.length > 30) throw new Error('Use up to 30 timeline tags.')
  const rows = value.map(row => {
    if (!row || Object.keys(row).sort().join() !== 'end,kind,start' || !['focused', 'distracted', 'flow'].includes(row.kind) || !Number.isFinite(row.start) || !Number.isFinite(row.end) || row.start < 0 || row.start >= row.end || row.end > session.elapsed) throw new Error('Tags must be within the session and have a positive duration.')
    if (session.timeline.some(interval => interval.state === 'break' && row.start < interval.end && row.end > interval.start)) throw new Error('Tags cannot overlap breaks.')
    return { start: row.start, end: row.end, kind: row.kind } as Annotation
  }).sort((a, b) => a.start - b.start)
  if (rows.some((row, i) => i > 0 && rows[i - 1].end > row.start)) throw new Error('Tags cannot overlap.')
  return rows
}
export class AwayDetector {
  private absentSince: number | null = null
  reset() { this.absentSince = null }
  classify(faceCount: number | null, observedAt: number, now: number): Presence {
    if (faceCount === null || faceCount > 1 || faceCount < 0 || now < observedAt || now - observedAt > 2) { this.reset(); return 'unknown' }
    if (faceCount === 1) { this.reset(); return 'present' }
    this.absentSince ??= now
    return now - this.absentSince >= 10 ? 'away' : 'unknown'
  }
}
export function csvExport(sessions: ReturnType<typeof withReport>[]) {
  // Spreadsheet formula escaping applies even to quoted cells.
  const cell = (value: unknown) => { let text = String(value ?? ''); if (/^[\s]*[=+@-]/.test(text)) text = "'" + text; return '"' + text.replaceAll('"', '""') + '"' }
  const rows: unknown[][] = [['id', 'task', 'mode', 'started_at', 'ended_at', 'status', 'study_seconds', 'deep_seconds', 'normal_seconds', 'distracted_seconds', 'unknown_seconds', 'break_seconds']]
  for (const s of sessions) rows.push([s.id, s.task, s.mode, s.started_at, s.ended_at, s.status, s.elapsed - s.totals.break, s.study_periods.totals.deep, s.study_periods.totals.normal, s.study_periods.totals.distracted, s.totals.unknown, s.totals.break])
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n'
}
