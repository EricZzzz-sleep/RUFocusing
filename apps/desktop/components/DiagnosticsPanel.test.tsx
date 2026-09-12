import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { diagnosticCommand, diagnosticsState, diagnosticDetail } from '../src/diagnostics-api'
import type { DiagnosticRecord, DiagnosticState } from '../src/types'
import DiagnosticsPanel from './DiagnosticsPanel'
import DiagnosticResults from './DiagnosticResults'

vi.mock('../src/diagnostics-api', () => ({ diagnosticCommand: vi.fn(), diagnosticsState: vi.fn(), diagnosticDetail: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const initial = (): DiagnosticState => ({ check: null, trial: null, recent: [], calibration_ready: true, calibration_busy: false })
const record = (kind: DiagnosticRecord['kind'] = 'check'): DiagnosticRecord => ({ id: 'check-id', kind, status: 'running', reason: null, session_id: 'session', calibration_id: 'calibration', model_version: 'iris-ridge-v1', protocol_version: 'gaze-reliability-v1', created_at: '2026-09-10T12:00:00Z', display: { width: 1440, height: 900, device_pixel_ratio: 1 }, camera_config: [0, 640, 480], conditions: { lighting: 'normal', glasses: 'none', distance: 'normal', notes: '' }, targets: [], target_order: [.2, .5, .8].flatMap(y => [.2, .5, .8].map(x => [x, y] as [number, number])), completed_targets: 0, collecting: false, durations: {}, coverage: null })

describe('Guided reliability diagnostics', () => {
  let host: HTMLDivElement, root: Root
  const changed = vi.fn()
  beforeEach(() => {
    vi.useFakeTimers()
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    vi.mocked(diagnosticsState).mockResolvedValue(initial())
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, writable: true, value: null })
    Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: vi.fn(async () => { Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: document.documentElement }) }) })
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: vi.fn(async () => { Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null }); document.dispatchEvent(new Event('fullscreenchange')) }) })
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true } })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false } })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16))
    vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  })
  afterEach(async () => {
    await act(async () => root.unmount()); host.remove(); vi.resetAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals()
    for (const key of ['showModal', 'close']) Reflect.deleteProperty(HTMLDialogElement.prototype, key)
    Reflect.deleteProperty(document.documentElement, 'requestFullscreen'); Reflect.deleteProperty(document, 'exitFullscreen'); Reflect.deleteProperty(document, 'fullscreenElement')
  })
  async function render(visible = true) { await act(async () => root.render(<DiagnosticsPanel enabled busy={false} visible={visible} inSession onCollectionChange={changed} />)) }
  async function click(text: string) { await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === text)!.click()) }

  it('waits for rendering before acknowledging targets and completes all nine', async () => {
    let current = initial()
    vi.mocked(diagnosticsState).mockImplementation(async () => {
      if (current.check?.collecting) current = { ...current, check: { ...current.check, collecting: false, completed_targets: current.check.completed_targets! + 1 } }
      return current
    })
    vi.mocked(diagnosticCommand).mockImplementation(async (_group, action, body) => {
      if (action === 'start') current = { ...current, check: record() }
      if (action === 'target') {
        expect(host.querySelector('[aria-label^="Accuracy target"]')).not.toBeNull()
        expect((body as { target_index: number }).target_index).toBe(current.check!.completed_targets)
        current = { ...current, check: { ...current.check!, collecting: true } }
      }
      if (action === 'complete') current = { ...current, check: null, recent: [{ ...record(), status: 'passed' }] }
      return current
    })
    await render(); await click('Check gaze accuracy')
    expect(diagnosticCommand).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 12; i++) { await act(async () => vi.advanceTimersByTimeAsync(1100)); await act(async () => vi.advanceTimersByTimeAsync(50)) }
    expect(vi.mocked(diagnosticCommand).mock.calls.filter(([, action]) => action === 'target')).toHaveLength(9)
    expect(vi.mocked(diagnosticCommand).mock.calls.some(([, action]) => action === 'complete')).toBe(true)
    expect(host.querySelector('dialog')).toBeNull()
    expect(changed).toHaveBeenLastCalledWith(false)
  })

  it('cancels a late start response after navigation and does not reopen fullscreen', async () => {
    let resolve!: (value: DiagnosticState) => void
    vi.mocked(diagnosticCommand).mockImplementation(async (_group, action) => action === 'start' ? new Promise(done => { resolve = done }) : initial())
    await render(); await click('Check gaze accuracy'); await render(false)
    await act(async () => resolve({ ...initial(), check: record() }))
    expect(host.querySelector('dialog')).toBeNull()
    expect(vi.mocked(diagnosticCommand).mock.calls).toContainEqual(['checks', 'cancel', { id: 'check-id' }])
    expect(document.fullscreenElement).toBeNull()
  })

  it('keeps a failed target request retryable without restarting the check', async () => {
    vi.mocked(diagnosticCommand).mockImplementation(async (_group, action) => {
      if (action === 'target') throw new Error('Target acknowledgement failed')
      return { ...initial(), check: record() }
    })
    await render(); await click('Check gaze accuracy')
    await act(async () => vi.advanceTimersByTimeAsync(50))
    expect(host.textContent).toContain('Target acknowledgement failed')
    await click('Retry request'); await act(async () => vi.advanceTimersByTimeAsync(50))
    expect(vi.mocked(diagnosticCommand).mock.calls.filter(([, action]) => action === 'start')).toHaveLength(1)
    expect(vi.mocked(diagnosticCommand).mock.calls.filter(([, action]) => action === 'target')).toHaveLength(2)
    await click('Cancel accuracy check')
    expect(host.querySelector('dialog')).toBeNull()
  })

  it('requires explicit action for due reminders and dismisses without ending the session', async () => {
    const trial = { ...record('trial'), study_seconds: 601, reminder: 'mid', checkpoints: { mid: { status: 'pending', check_id: null } } }
    vi.mocked(diagnosticsState).mockResolvedValue({ ...initial(), trial })
    vi.mocked(diagnosticCommand).mockResolvedValue({ ...initial(), trial: { ...trial, reminder: null } })
    await render()
    expect(document.documentElement.requestFullscreen).not.toHaveBeenCalled()
    expect(host.textContent).toContain('10-minute accuracy check is due')
    await click('Dismiss reminder')
    expect(diagnosticCommand).toHaveBeenCalledWith('trials', 'reminder', { id: 'check-id', checkpoint: 'mid' })
    expect(host.textContent).not.toContain('accuracy check is due')
  })

  it('renders incomplete results without invented error values', async () => {
    const incomplete = { ...record(), status: 'incomplete' as const, median_error: null, p90_error: null, valid_count: 0, coverage: 0, durations: { eyes_closed: 27 } }
    vi.mocked(diagnosticDetail).mockResolvedValue(incomplete)
    await act(async () => root.render(<DiagnosticResults records={[incomplete]} />))
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click())
    expect(host.textContent).toContain('N/A median / N/A p90')
    expect(host.textContent).toContain('eyes closed')
    expect(host.textContent).toContain('baseline only, no coverage pass/fail threshold')
  })
})
