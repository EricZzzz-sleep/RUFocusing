import { describe, expect, it } from 'vitest'
import { coverage, dailyStudy, filterHistory, inPeriod, summarize } from './analysis'
import type { StudySession } from './types'

function session(id: string, started_at: string, changes: Partial<StudySession> = {}): StudySession {
  return { id, task: `Task ${id}`, mode: 'Reading', started_at, ended_at: started_at,
    status: 'completed', camera_enabled: false, elapsed: 100, timeline: [],
    totals: { present: 40, away: 10, unknown: 30, break: 20 }, longest_present: 40, ...changes }
}

describe('Saved session analysis', () => {
  const now = new Date(2026, 8, 9, 12)
  const date = (day: number, hour = 12) => new Date(2026, 8, day, hour).toISOString()

  it('includes today and the first local day, excludes older/future/active sessions, and sorts newest first', () => {
    const sessions = [session('boundary', date(3, 0)), session('old', date(2, 23)), session('today', date(9, 23)),
      session('future', date(10, 0)), session('active', date(9), { status: 'running' }), session('paused', date(9), { status: 'break' })]
    expect(inPeriod(sessions, '7', now).map(item => item.id)).toEqual(['today', 'boundary'])
    expect(inPeriod(sessions, '30', now).map(item => item.id)).toEqual(['today', 'boundary', 'old'])
  })

  it('computes weighted coverage from durations and includes interrupted sessions', () => {
    const sessions = [session('a', date(8)), session('b', date(9), { status: 'interrupted', elapsed: 920,
      totals: { present: 0, away: 0, unknown: 900, break: 20 }, longest_present: 0 })]
    const summary = summarize(inPeriod(sessions, '7', now))
    expect(summary).toEqual({ count: 2, study: 980, present: 40, observed: 50, longest: 40, coverage: '5%' })
    expect(coverage(0, 80)).toBe('0%')
    expect(coverage(0, 0)).toBe('N/A')
    expect(summarize([]).coverage).toBe('N/A')
  })

  it('zero-fills days and groups a cross-midnight session entirely by its local start date', () => {
    const sessions = [session('late', date(8, 23), { ended_at: date(9, 1) }), session('same', date(8, 15))]
    const days = dailyStudy(sessions, '7', now)
    expect(days).toHaveLength(7)
    expect(days[0].date).toBe('2026-09-03')
    expect(days[5]).toMatchObject({ date: '2026-09-08', sessions: 2, study: 160, present: 80, away: 20, unknown: 60, breaks: 40 })
    expect(days[6]).toMatchObject({ date: '2026-09-09', sessions: 0, study: 0 })
    expect(days.reduce((total, day) => total + day.study, 0)).toBe(summarize(sessions).study)
  })

  it('supports empty, zero-duration, timer-only, and all-time data', () => {
    expect(dailyStudy([], '30', now)).toHaveLength(30)
    expect(dailyStudy([], 'all', now)).toHaveLength(1)
    const timerOnly = session('timer', date(1), { elapsed: 60, totals: { present: 0, away: 0, break: 0, unknown: 60 }, longest_present: 0 })
    const zero = session('zero', date(9), { elapsed: 0, totals: { present: 0, away: 0, break: 0, unknown: 0 }, longest_present: 0 })
    const days = dailyStudy([timerOnly, zero], 'all', now)
    expect(days).toHaveLength(9)
    expect(days[0].unknown).toBe(60)
    expect(days[8].sessions).toBe(1)
    expect(summarize([zero]).coverage).toBe('N/A')
    expect(summarize([timerOnly]).coverage).toBe('0%')
  })

  it('iterates calendar dates across the daylight-saving transition', () => {
    const days = dailyStudy([], '7', new Date(2026, 2, 10, 12))
    expect(days.map(day => day.date)).toEqual(['2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'])
  })

  it('combines history filters without changing aggregate source data', () => {
    const sessions = [session('a', date(9), { task: 'Linear Algebra', mode: 'Math', status: 'interrupted' }), session('b', date(8))]
    expect(filterHistory(sessions, '  ALGEBRA ', 'Math', 'interrupted').map(item => item.id)).toEqual(['a'])
    expect(filterHistory(sessions, 'Algebra', 'Coding', '')).toEqual([])
    expect(filterHistory(sessions, '', '', '')).toHaveLength(2)
    expect(summarize(sessions).count).toBe(2)
  })
})
