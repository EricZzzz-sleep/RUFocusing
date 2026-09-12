import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonRequest } from '../src/api'
import type { SessionAnalysis, StudySession } from '../src/types'
import StudyPatternReport from './StudyPatternReport'

vi.mock('../src/api', () => ({ jsonRequest: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const session: StudySession = { id: 'saved', task: 'Paper reading', mode: 'Reading', status: 'completed', camera_enabled: false, started_at: '2026-09-11', ended_at: '2026-09-11', elapsed: 1500,
  timeline: [{ start: 0, end: 1200, state: 'unknown' }, { start: 1200, end: 1300, state: 'break' }, { start: 1300, end: 1500, state: 'present' }],
  totals: { present: 200, away: 0, unknown: 1200, break: 100 }, longest_present: 200 }
const result = (): SessionAnalysis => ({ session_id: 'saved', threshold_seconds: 600, intervals: session.timeline, sustained_periods: [], interruptions: [],
  exclusions: [{ run_id: 'check', start: 1400, end: 1450, kind: 'check' }], annotations: [], reflection: { concentration: null, distraction: null, flow: null },
  summary: { version: 'study-patterns-v1', availability: { available: true, reasons: [] }, sustained_count: 0, sustained_seconds: 0, longest_sustained: 0,
    interruption_count: 0, interruption_seconds: 0, eligible_seconds: 1350, observed_seconds: 150, observation_coverage: 150 / 1350,
    tagged_seconds: { focused: 0, distracted: 0, flow: 0 }, self_reported_sustained_seconds: 0, reflection: { concentration: null, distraction: null, flow: null } } })

describe('Saved study pattern report', () => {
  let host: HTMLDivElement, root: Root
  beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); vi.mocked(jsonRequest).mockResolvedValue(result()) })
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.resetAllMocks() })
  async function render() { await act(async () => root.render(<StudyPatternReport session={session} />)) }
  async function click(text: string) { await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === text)!.click()) }
  async function field(label: string, value: string) {
    const node = [...host.querySelectorAll('label')].find(item => item.firstChild?.textContent === label)!.querySelector<HTMLInputElement | HTMLSelectElement>('input,select')!
    await act(async () => {
      const prototype = node.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLSelectElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value)
      node.dispatchEvent(new Event(node.tagName === 'INPUT' ? 'input' : 'change', { bubbles: true }))
    })
    return node
  }
  it('offers skipped ratings and renders separate evidence layers without automatic mental-state labels', async () => {
    await render()
    expect([...host.querySelectorAll('.reflection-fields select')].map(node => (node as HTMLSelectElement).value)).toEqual(['', '', ''])
    expect(host.textContent).toContain('Concentration N/A')
    expect(host.textContent).toContain('not a validated psychological scale')
    expect(host.textContent).toContain('never automatically labeled distraction or flow')
    expect(host.querySelector('.evidence-unknown')).not.toBeNull()
    expect(host.querySelector('.tag-track .tag-focused')).toBeNull()
  })
  it('retains reflection values on failure and prevents duplicate commands while saving', async () => {
    await render(); await field('Concentration', '4'); await field('Self-reported flow', 'yes')
    let reject!: (reason: Error) => void
    vi.mocked(jsonRequest).mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail }))
    await click('Save reflection')
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(jsonRequest).toHaveBeenCalledTimes(2)
    expect(host.querySelector('fieldset')!.disabled).toBe(true)
    await act(async () => reject(new Error('Database unavailable')))
    expect(host.textContent).toContain('The session is already saved')
    expect(host.querySelector<HTMLSelectElement>('select')!.value).toBe('4')
    await click('Save reflection')
    expect(jsonRequest).toHaveBeenLastCalledWith('/api/sessions/saved/reflection', { concentration: 4, distraction: null, flow: 'yes' })
    expect(host.textContent).toContain('Reflection saved.')
  })
  it('clears an answer through the replacement reflection request', async () => {
    const saved = result(); saved.reflection = { concentration: 3, distraction: 2, flow: 'no' }; saved.summary.reflection = saved.reflection
    vi.mocked(jsonRequest).mockResolvedValue(saved)
    await render(); await field('Concentration', ''); await field('Distraction frequency', ''); await field('Self-reported flow', '')
    await click('Save reflection')
    expect(jsonRequest).toHaveBeenLastCalledWith('/api/sessions/saved/reflection', { concentration: null, distraction: null, flow: null })
  })
  it('tags unknown time, previews coordinates, labels sustained tags, and preserves tags after save failure', async () => {
    await render(); await field('End time', '00:10:00')
    expect(host.querySelector('[aria-label="Tag preview: Focused, 00:00:00 to 00:10:00."]')).not.toBeNull()
    await click('Add tag to list')
    expect(host.querySelector('.annotation-list')!.textContent).toContain('Self-reported sustained focus')
    expect(host.querySelector('.evidence-unknown')).not.toBeNull()
    vi.mocked(jsonRequest).mockRejectedValueOnce(new Error('Save failed'))
    await click('Save timeline tags')
    expect(host.querySelector('.annotation-list li')).not.toBeNull()
    await click('Save timeline tags')
    expect(jsonRequest).toHaveBeenLastCalledWith('/api/sessions/saved/annotations', { annotations: [{ start: 0, end: 600, kind: 'focused' }] })
  })
  it('rejects overlaps, breaks, diagnostics and invalid bounds without sending requests', async () => {
    await render()
    for (const [start, end, error] of [['00:00:00', '00:26:00', 'start before end'], ['00:20:00', '00:21:00', 'cannot overlap breaks'], ['00:23:20', '00:24:00', 'cannot overlap breaks']]) {
      await field('Start time', start); await field('End time', end); await click('Add tag to list'); expect(host.textContent).toContain(error)
    }
    await field('Start time', '00:00:00'); await field('End time', '00:01:00'); await click('Add tag to list'); await click('Add tag to list')
    expect(host.textContent).toContain('Tags cannot overlap one another')
    expect(jsonRequest).toHaveBeenCalledTimes(1)
  })
  it('edits and deletes tags with focus restored to the accessible start input', async () => {
    await render(); await field('End time', '00:10:00'); await click('Add tag to list')
    await click('Edit'); expect(document.activeElement).toBe(host.querySelector('.tag-fields input'))
    await field('End time', '00:09:00'); await click('Update tag in list')
    expect(host.querySelector('.annotation-list')!.textContent).not.toContain('Self-reported sustained focus')
    await click('Delete'); expect(document.activeElement).toBe(host.querySelector('.tag-fields input'))
    await click('Save timeline tags'); expect(jsonRequest).toHaveBeenLastCalledWith('/api/sessions/saved/annotations', { annotations: [] })
  })
  it('recovers failed loading and ignores a late response after unmount', async () => {
    vi.mocked(jsonRequest).mockRejectedValueOnce(new Error('Disconnected'))
    await render(); expect(host.textContent).toContain('Your saved session is safe')
    await click('Retry study patterns'); expect(host.textContent).toContain('Optional personal reflection')
    let resolve!: (value: SessionAnalysis) => void
    vi.mocked(jsonRequest).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await click('Save reflection'); await act(async () => root.render(null)); await act(async () => resolve(result()))
    expect(host.textContent).toBe('')
  })
})
