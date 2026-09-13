import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StudySession } from '../src/types'
import { inPeriod } from '../src/analysis'
import StudyTimeline, { sumStudyPeriods } from './StudyTimeline'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const session = (): StudySession => ({ id: 'study', task: 'Algebra', mode: 'Math', started_at: new Date().toISOString(), ended_at: null,
  status: 'running', camera_enabled: true, elapsed: 900, timeline: [], totals: { present: 850, away: 30, break: 10, unknown: 10 }, longest_present: 600,
  study_periods: { available: true, totals: { deep: 600, normal: 250, distracted: 30 }, intervals: [
    { start: 0, end: 600, state: 'deep' }, { start: 600, end: 610, state: 'unknown' },
    { start: 610, end: 640, state: 'distracted' }, { start: 640, end: 890, state: 'normal' }, { start: 890, end: 900, state: 'break' },
  ] } })

describe('Simple study timeline', () => {
  let host: HTMLDivElement, root: Root
  beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })

  it('renders three server totals and accessible periods with neutral gaps', async () => {
    await act(async () => root.render(<StudyTimeline session={session()} />))
    expect([...host.querySelectorAll('.study-total strong')].map(node => node.textContent)).toEqual(['10m 0s', '4m 10s', '30s'])
    expect(host.querySelectorAll('.study-gap')).toHaveLength(2)
    expect(host.querySelectorAll('svg [role="button"][tabindex="0"]')).toHaveLength(5)
    expect(host.querySelector('.period-info')?.hasAttribute('open')).toBe(false)
    expect(host.querySelector('.period-unknown .study-step')).toBeNull()
    // There is no connecting line across the unavailable interval.
    expect(host.querySelectorAll('g.period-distracted .study-step')).toHaveLength(1)
  })

  it('supports focus, keyboard activation and taps for exact period details', async () => {
    await act(async () => root.render(<StudyTimeline session={session()} />))
    const period = host.querySelector<SVGGElement>('g.period-distracted')!
    await act(async () => period.focus())
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Distracted · 00:10:10–00:10:40 · 30s')
    await act(async () => period.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(period.getAttribute('aria-pressed')).toBe('true')
    await act(async () => host.querySelector('g.period-break')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Break · 00:14:50–00:15:00')
  })

  it('updates an entire live period at the threshold using the new server result', async () => {
    const current = session()
    current.elapsed = 599
    current.study_periods = { available: true, totals: { deep: 0, normal: 599, distracted: 0 }, intervals: [{ start: 0, end: 599, state: 'normal' }] }
    await act(async () => root.render(<StudyTimeline session={current} />))
    expect(host.querySelector('g.period-normal')).not.toBeNull()
    current.elapsed = 600
    current.study_periods = { available: true, totals: { deep: 600, normal: 0, distracted: 0 }, intervals: [{ start: 0, end: 600, state: 'deep' }] }
    await act(async () => root.render(<StudyTimeline session={{ ...current }} />))
    expect(host.querySelector('g.period-normal')).toBeNull()
    expect(host.querySelector('g.period-deep')?.getAttribute('aria-label')).toContain('00:00:00–00:10:00')
  })

  it('shows unavailable data without inventing normal study', async () => {
    const current = session()
    current.study_periods = { available: false, totals: { deep: 0, normal: 0, distracted: 0 }, intervals: [{ start: 0, end: 900, state: 'unknown' }] }
    await act(async () => root.render(<StudyTimeline session={current} />))
    expect(host.querySelector('.chart-empty')?.textContent).toBe('No tracking data')
    expect(host.querySelector('g.period-normal')).toBeNull()
    expect([...host.querySelectorAll('.study-total strong')].map(node => node.textContent)).toEqual(['—', '—', '—'])
  })

  it('aggregates only available backend totals in the selected date range', () => {
    const old = { ...session(), id: 'old', started_at: '2020-01-01T12:00:00Z' }
    const missing = { ...session(), id: 'missing', study_periods: undefined }
    const rows = [session(), old, missing].map(row => ({ ...row, status: 'completed' as const }))
    expect(sumStudyPeriods(inPeriod(rows, '7')).totals).toEqual({ deep: 600, normal: 250, distracted: 30 })
    expect(sumStudyPeriods(inPeriod(rows, 'all')).totals).toEqual({ deep: 1200, normal: 500, distracted: 60 })
    expect(sumStudyPeriods([]).available).toBe(false)
  })
})
