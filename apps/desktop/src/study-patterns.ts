import type { StudySession } from './types'

export const availabilityReasons: Record<string, string> = {
  historical_diagnostic_boundaries_missing: 'Older diagnostics do not have exact session times. Behavioral metrics are unavailable; your reflection and tags can still be saved.',
  upgrade_during_session: 'This session was active during an upgrade, so its diagnostic boundaries are incomplete. Behavioral metrics are unavailable.',
  exclusion_provenance_missing: 'Diagnostic timing provenance is missing. Behavioral metrics are unavailable.',
  no_presence_observations: 'No reliable presence observations were recorded during eligible study time.',
  no_eligible_study_time: 'There is no study time outside breaks and diagnostics.',
}
export const annotationLabels = { focused: 'Focused', distracted: 'Distracted', flow: 'Flow' }
export function parseOffset(value: string): number | null {
  if (!/^\d+:\d{2}:\d{2}$/.test(value)) return null
  const [hours, minutes, seconds] = value.split(':').map(Number)
  if (minutes > 59 || seconds > 59) return null
  const total = hours * 3600 + minutes * 60 + seconds
  return Number.isSafeInteger(total) ? total : null
}
export function summarizePatterns(sessions: StudySession[]) {
  const summaries = sessions.flatMap(session => session.analysis_summary ? [session.analysis_summary] : [])
  const behavioral = summaries.filter(summary => summary.availability.available)
  const ratings = (key: 'concentration' | 'distraction') => {
    const values = summaries.flatMap(summary => summary.reflection[key] === null ? [] : [summary.reflection[key]!])
    return { count: values.length, average: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null }
  }
  const observed = summaries.reduce((sum, row) => sum + (row.observed_seconds ?? 0), 0)
  const eligible = summaries.reduce((sum, row) => sum + (row.eligible_seconds ?? 0), 0)
  return {
    available: behavioral.length, unavailable: sessions.length - behavioral.length,
    sustainedCount: behavioral.reduce((sum, row) => sum + row.sustained_count!, 0),
    sustained: behavioral.reduce((sum, row) => sum + row.sustained_seconds!, 0),
    longest: Math.max(0, ...behavioral.map(row => row.longest_sustained!)),
    interruptions: behavioral.reduce((sum, row) => sum + row.interruption_count!, 0),
    away: behavioral.reduce((sum, row) => sum + row.interruption_seconds!, 0),
    coverage: eligible > 0 ? observed / eligible : null,
    tagged: { focused: summaries.reduce((sum, row) => sum + row.tagged_seconds.focused, 0),
      distracted: summaries.reduce((sum, row) => sum + row.tagged_seconds.distracted, 0),
      flow: summaries.reduce((sum, row) => sum + row.tagged_seconds.flow, 0) },
    sustainedReported: summaries.reduce((sum, row) => sum + row.self_reported_sustained_seconds, 0),
    concentration: ratings('concentration'), distraction: ratings('distraction'),
    flow: { yes: summaries.filter(row => row.reflection.flow === 'yes').length,
      no: summaries.filter(row => row.reflection.flow === 'no').length,
      unsure: summaries.filter(row => row.reflection.flow === 'unsure').length,
      count: summaries.filter(row => row.reflection.flow !== null).length },
  }
}
