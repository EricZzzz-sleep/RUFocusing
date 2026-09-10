import type { StudySession } from './types'

export type Period = '7' | '30' | 'all'
export const periods: Record<Period, string> = { '7': 'Last 7 days', '30': 'Last 30 days', all: 'All time' }
export const studyTime = (session: StudySession) => Math.max(0, session.elapsed - session.totals.break)
export const coverage = (observed: number, study: number) => study > 0 ? `${Math.round(observed / study * 100)}%` : 'N/A'
export const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

export function inPeriod(sessions: StudySession[], period: Period, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  if (period !== 'all') start.setDate(start.getDate() - Number(period) + 1)
  return sessions.filter(session => {
    const timestamp = new Date(session.started_at).getTime()
    return (session.status === 'completed' || session.status === 'interrupted') &&
      timestamp < end.getTime() && (period === 'all' || timestamp >= start.getTime())
  }).sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
}

export function summarize(sessions: StudySession[]) {
  const totals = sessions.reduce((sum, session) => ({
    study: sum.study + studyTime(session),
    present: sum.present + session.totals.present,
    observed: sum.observed + session.totals.present + session.totals.away,
    longest: Math.max(sum.longest, session.longest_present),
  }), { study: 0, present: 0, observed: 0, longest: 0 })
  return { ...totals, count: sessions.length, coverage: coverage(totals.observed, totals.study) }
}

export interface DailyStudy {
  date: string
  label: string
  sessions: number
  present: number
  away: number
  unknown: number
  study: number
  breaks: number
}

// Calendar-day iteration keeps local midnight boundaries correct across DST.
export function dailyStudy(sessions: StudySession[], period: Period, now = new Date()): DailyStudy[] {
  const selected = inPeriod(sessions, period, now)
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const start = new Date(end)
  if (period === 'all' && selected.length) {
    const first = new Date(selected[selected.length - 1].started_at)
    start.setFullYear(first.getFullYear(), first.getMonth(), first.getDate())
  } else if (period !== 'all') start.setDate(start.getDate() - Number(period) + 1)
  const rows = new Map<string, DailyStudy>()
  for (const day = new Date(start); day <= end; day.setDate(day.getDate() + 1)) {
    const date = localDay(day)
    rows.set(date, { date, label: day.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
      sessions: 0, present: 0, away: 0, unknown: 0, study: 0, breaks: 0 })
  }
  for (const session of selected) {
    const row = rows.get(localDay(new Date(session.started_at)))!
    row.sessions++
    row.present += session.totals.present
    row.away += session.totals.away
    row.unknown += session.totals.unknown
    row.study += studyTime(session)
    row.breaks += session.totals.break
  }
  return [...rows.values()]
}

export function filterHistory(sessions: StudySession[], search: string, mode: string, status: string) {
  return sessions.filter(session => session.task.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) &&
    (!mode || session.mode === mode) && (!status || session.status === status))
}
