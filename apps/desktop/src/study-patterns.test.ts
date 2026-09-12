import { describe, expect, it } from 'vitest'
import { inPeriod, filterHistory } from './analysis'
import { parseOffset, summarizePatterns } from './study-patterns'
import type { AnalysisSummary, StudySession } from './types'

export const exampleSummary = (): AnalysisSummary => ({
  version: 'study-patterns-v1', availability: { available: true, reasons: [] },
  sustained_count: 1, sustained_seconds: 600, longest_sustained: 600, interruption_count: 2, interruption_seconds: 20,
  eligible_seconds: 1000, observed_seconds: 800, observation_coverage: .8,
  tagged_seconds: { focused: 600, distracted: 10, flow: 0 }, self_reported_sustained_seconds: 600,
  reflection: { concentration: 5, distraction: null, flow: 'yes' },
})
function session(id: string, day: number, summary = exampleSummary()): StudySession {
  return { id, started_at: new Date(2026, 8, day, 23, 59).toISOString(), ended_at: new Date(2026, 8, day + 1).toISOString(),
    task: id, mode: 'Reading', camera_enabled: true, status: 'completed', elapsed: 1000, timeline: [],
    totals: { present: 780, away: 20, unknown: 200, break: 0 }, longest_present: 600, analysis_summary: summary }
}
describe('Study-pattern aggregates', () => {
  it('keeps absent ratings N/A and includes unknown study time in weighted coverage', () => {
    const unknown = exampleSummary()
    Object.assign(unknown, { availability: { available: false, reasons: ['no_presence_observations'] }, sustained_count: null, sustained_seconds: null,
      longest_sustained: null, interruption_count: null, interruption_seconds: null, eligible_seconds: 3000, observed_seconds: 0, observation_coverage: 0,
      reflection: { concentration: null, distraction: 2, flow: 'unsure' } })
    const result = summarizePatterns([session('observed', 11), session('timer', 11, unknown)])
    expect(result).toMatchObject({ available: 1, unavailable: 1, sustainedCount: 1, sustained: 600, longest: 600, interruptions: 2, away: 20, coverage: .2,
      concentration: { average: 5, count: 1 }, distraction: { average: 2, count: 1 }, flow: { yes: 1, no: 0, unsure: 1, count: 2 } })
    expect(summarizePatterns([]).concentration).toEqual({ average: null, count: 0 })
    expect(summarizePatterns([]).coverage).toBeNull()
  })
  it('uses selected local start dates, includes interrupted sessions, and leaves history filters independent', () => {
    const records = [session('boundary', 5), session('older', 4), { ...session('today', 11), status: 'interrupted' as const }, { ...session('active', 11), status: 'running' as const }]
    const selected = inPeriod(records, '7', new Date(2026, 8, 11, 12))
    expect(selected.map(row => row.id)).toEqual(['today', 'boundary'])
    expect(summarizePatterns(selected).sustained).toBe(1200)
    expect(summarizePatterns(inPeriod(records, '30', new Date(2026, 8, 11))).sustained).toBe(1800)
    expect(summarizePatterns(inPeriod(records, 'all', new Date(2026, 8, 11))).tagged.focused).toBe(1800)
    expect(filterHistory(selected, 'boundary', 'Reading', '')).toHaveLength(1)
    expect(summarizePatterns(selected).concentration.count).toBe(2)
  })
  it('omits untrustworthy historical behavioral totals while retaining their submitted reflection', () => {
    const old = exampleSummary()
    Object.assign(old, { availability: { available: false, reasons: ['historical_diagnostic_boundaries_missing'] }, sustained_count: null, sustained_seconds: null,
      longest_sustained: null, interruption_count: null, interruption_seconds: null, eligible_seconds: null, observed_seconds: null, observation_coverage: null })
    expect(summarizePatterns([session('old', 1, old)])).toMatchObject({ available: 0, unavailable: 1, coverage: null, concentration: { average: 5, count: 1 }, sustainedReported: 600 })
  })
  it('parses accessible elapsed times without accepting invalid or ambiguous input', () => {
    expect(parseOffset('00:10:00')).toBe(600)
    expect(parseOffset('125:59:59')).toBe(453599)
    for (const text of ['10', '00:60:00', '00:00:60', '-1:00:00', '01:2:03', '', 'Infinity:00:00']) expect(parseOffset(text)).toBeNull()
  })
})
