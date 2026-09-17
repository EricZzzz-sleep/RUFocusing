import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gazeRequest } from '../src/gaze-api'
import type { GazeState } from '../src/types'
import GazePanel from './GazePanel'

vi.mock('./DiagnosticsPanel', () => ({ default: () => null }))
vi.mock('../src/gaze-api', () => ({ gazeRequest: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const initial = (): GazeState => ({ experimental: true, quality: 'usable',
  observation: { timestamp: 0, valid: false, x: null, y: null, region: null, reason: 'uncalibrated', calibration_id: null },
  calibration: { id: null, status: 'uncalibrated', reason: 'uncalibrated', display: null, validation: null,
    target_index: null, target: null, target_count: 13, targets: [...[.1,.5,.9].flatMap(y => [.1,.5,.9].map(x => [x,y] as [number,number])), ...[.3,.7].flatMap(y => [.3,.7].map(x => [x,y] as [number,number]))],
    completed_targets: 0, samples: 0, collecting: false, target_error: null } })
const ready = (): GazeState => { const state = initial(); state.calibration.status = 'ready'; state.calibration.id = 'calibration'; state.calibration.reason = 'estimated'; state.observation = { timestamp: 1, valid: true, x: .2, y: .7, region: 'bottom_left', reason: 'estimated', calibration_id: 'calibration' }; return state }

describe('Gaze calibration and live feedback', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    vi.useFakeTimers()
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null, writable: true })
    Object.defineProperty(document.documentElement, 'requestFullscreen', { configurable: true, value: vi.fn(async () => { Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: document.documentElement }) }) })
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: vi.fn(async () => { Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null }); document.dispatchEvent(new Event('fullscreenchange')) }) })
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true } })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false } })
  })
  afterEach(async () => {
    await act(async () => root.unmount()); host.remove(); vi.resetAllMocks(); vi.useRealTimers()
    for (const key of ['showModal', 'close']) Reflect.deleteProperty(HTMLDialogElement.prototype, key)
    Reflect.deleteProperty(document.documentElement, 'requestFullscreen')
    Reflect.deleteProperty(document, 'exitFullscreen'); Reflect.deleteProperty(document, 'fullscreenElement')
  })
  async function render(enabled = true, visible = true) { await act(async () => root.render(<GazePanel enabled={enabled} visible={visible} busy={false} />)) }
  async function click(text: string) { await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent?.includes(text))!.click()) }


  it('cancels calibration when Record is hidden, without stealing page focus', async () => {
    let current = initial()
    vi.mocked(gazeRequest).mockImplementation(async action => {
      if (action === 'start') current = { ...current, calibration: { ...current.calibration, id: 'hidden-calibration', status: 'collecting', collecting: true } }
      if (action === 'reset') current = initial()
      return current
    })
    await render()
    await click('Set up gaze')
    const heading = document.createElement('h1'); heading.tabIndex = -1; document.body.append(heading); heading.focus()
    await render(true, false)
    expect(host.querySelector('dialog')).toBeNull()
    expect(vi.mocked(gazeRequest).mock.calls).toContainEqual(['reset', { calibration_id: 'hidden-calibration' }])
    expect(document.activeElement).toBe(heading)
    heading.remove()
  })

  it('shows a compact ready status and clears it during service loss', async () => {
    vi.mocked(gazeRequest).mockResolvedValue(ready())
    await render()
    expect(host.textContent).toContain('Gaze ready')
    expect(host.querySelector('.gaze-map')).toBeNull()
    expect(host.textContent).not.toContain('Gaze reliability')
    vi.mocked(gazeRequest).mockImplementation(() => new Promise(() => {}))
    await act(async () => vi.advanceTimersByTimeAsync(900))
    expect(host.querySelector('.gaze-point')).toBeNull()
    expect(host.textContent).toContain('Connecting gaze')
    await render(false)
    expect(host.textContent).toContain('Camera off')
    expect(host.querySelector('button')?.disabled).toBe(true)
  })

  it('suppresses coordinates from failed calibration even if a response contains a point', async () => {
    const state = ready(); state.calibration.status = 'failed'; state.calibration.reason = 'calibration_accuracy_failed'
    vi.mocked(gazeRequest).mockResolvedValue(state)
    await render()
    expect(host.querySelector('.gaze-point')).toBeNull()
    expect(host.textContent).toContain('Set up gaze')
  })

  it('requests fullscreen, advances all server-defined targets, and completes calibration', async () => {
    let current = initial()
    vi.mocked(gazeRequest).mockImplementation(async (action, body) => {
      if (action === 'start') current = { ...initial(), calibration: { ...initial().calibration, id: 'calibration', status: 'collecting', reason: 'calibration_in_progress' } }
      if (action === 'target') {
        const index = (body as { target_index: number }).target_index
        expect(index).toBe(current.calibration.completed_targets)
        current = { ...current, calibration: { ...current.calibration, target_index: index, collecting: true, status: index >= 9 ? 'validating' : 'collecting' } }
      } else if (!action && current.calibration.collecting) {
        current = { ...current, calibration: { ...current.calibration, completed_targets: current.calibration.completed_targets + 1, collecting: false, samples: 11 } }
      }
      if (action === 'complete') current = ready()
      return current
    })
    await render()
    await click('Set up gaze')
    expect(document.documentElement.requestFullscreen).toHaveBeenCalledOnce()
    for (let index = 0; index < 15; index++) await act(async () => vi.advanceTimersByTimeAsync(250))
    expect(vi.mocked(gazeRequest).mock.calls.filter(([action]) => action === 'target')).toHaveLength(13)
    expect(vi.mocked(gazeRequest).mock.calls.some(([action]) => action === 'complete')).toBe(true)
    expect(host.querySelector('.calibration-screen')).toBeNull()
    expect(host.textContent).toContain('Redo setup')
    expect(document.exitFullscreen).toHaveBeenCalled()
  })

  it('cancels a pending start without leaving a calibration running', async () => {
    let resolveStart!: (state: GazeState) => void
    vi.mocked(gazeRequest).mockImplementation(action => action === 'start' ? new Promise(resolve => { resolveStart = resolve }) : Promise.resolve(initial()))
    await render()
    await click('Set up gaze')
    await click('Cancel setup')
    const started = initial(); started.calibration.id = 'pending-id'; started.calibration.status = 'collecting'
    await act(async () => resolveStart(started))
    expect(host.querySelector('.calibration-screen')).toBeNull()
    expect(vi.mocked(gazeRequest).mock.calls).toContainEqual(['reset', { calibration_id: 'pending-id' }])
    expect(host.querySelector('.gaze-point')).toBeNull()
  })

  it('keeps collection available for retry after an API error', async () => {
    let current = initial()
    vi.mocked(gazeRequest).mockImplementation(async action => {
      if (action === 'start') { current = { ...current, calibration: { ...current.calibration, id: 'calibration', status: 'collecting' } }; return current }
      if (action === 'target') throw new Error('Target request failed')
      return current
    })
    await render()
    await click('Set up gaze')
    await act(async () => vi.advanceTimersByTimeAsync(40))
    expect(host.textContent).toContain('Target request failed')
    expect([...host.querySelectorAll('button')].some(button => button.textContent === 'Retry target')).toBe(true)
    const [cancelButton, retryButton] = host.querySelectorAll<HTMLButtonElement>('dialog button')
    retryButton.focus()
    retryButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(cancelButton)
    cancelButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(retryButton)
    await click('Cancel setup')
    expect(host.querySelector('.calibration-screen')).toBeNull()
  })
  it('confirms the display on reload and resets saved setup explicitly', async () => {
    const current = ready()
    current.calibration.display = { width: 1440, height: 900, device_pixel_ratio: 2 }
    vi.mocked(gazeRequest).mockImplementation(async action => action === 'reset' ? initial() : current)
    await render()
    expect(vi.mocked(gazeRequest).mock.calls.some(([action]) => action === 'display')).toBe(true)
    await act(async () => vi.advanceTimersByTimeAsync(250))
    expect(host.textContent).toContain('Gaze ready')
    await click('Reset gaze setup')
    expect(vi.mocked(gazeRequest).mock.calls).toContainEqual(['reset', {}])
    expect(host.textContent).toContain('Set up gaze')
    expect(host.querySelector('.gaze-map')).toBeNull()
  })

  it('shows a short update action for an incompatible setup', async () => {
    const current = ready()
    current.observation = { ...current.observation, valid: false, reason: 'camera_config_changed_recalibrate' }
    vi.mocked(gazeRequest).mockResolvedValue(current)
    await render()
    expect(host.textContent).toContain('Setup needs updating')
    expect(host.textContent).toContain('Redo setup')
  })

  it('does not start after a delayed fullscreen grant when camera was disabled', async () => {
    let grant!: () => void
    vi.mocked(document.documentElement.requestFullscreen).mockImplementation(() => new Promise(resolve => {
      grant = () => { Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: document.documentElement }); resolve() }
    }))
    vi.mocked(gazeRequest).mockResolvedValue(initial())
    await render()
    await click('Set up gaze')
    await click('Updating setup')
    expect(document.documentElement.requestFullscreen).toHaveBeenCalledOnce()
    await render(false)
    await act(async () => grant())
    expect(vi.mocked(gazeRequest).mock.calls.some(([action]) => action === 'start')).toBe(false)
    expect(document.fullscreenElement).toBeNull()
    expect(host.querySelector('dialog')).toBeNull()
  })

  it('cancels a delayed start after disable, even if re-enabled before the response', async () => {
    let resolveStart!: (state: GazeState) => void
    vi.mocked(gazeRequest).mockImplementation(action => action === 'start' ? new Promise(resolve => { resolveStart = resolve }) : Promise.resolve(initial()))
    await render()
    await click('Set up gaze')
    await render(false)
    await render(true)
    const started = initial(); started.calibration.id = 'late-start'; started.calibration.status = 'collecting'
    await act(async () => resolveStart(started))
    expect(host.querySelector('dialog')).toBeNull()
    expect(vi.mocked(gazeRequest).mock.calls).toContainEqual(['reset', { calibration_id: 'late-start' }])
    expect(vi.mocked(gazeRequest).mock.calls.some(([action]) => action === 'target')).toBe(false)
  })

  it('cancels a start that finishes after the component unmounts', async () => {
    let resolveStart!: (state: GazeState) => void
    vi.mocked(gazeRequest).mockImplementation(action => action === 'start' ? new Promise(resolve => { resolveStart = resolve }) : Promise.resolve(initial()))
    await render()
    await click('Set up gaze')
    await act(async () => root.render(null))
    const started = initial(); started.calibration.id = 'unmounted'; started.calibration.status = 'collecting'
    await act(async () => resolveStart(started))
    expect(vi.mocked(gazeRequest).mock.calls).toContainEqual(['reset', { calibration_id: 'unmounted' }])
    expect(document.fullscreenElement).toBeNull()
  })

  it('ignores a target response arriving after cancellation', async () => {
    let resolveTarget!: (state: GazeState) => void
    const started = initial(); started.calibration.id = 'cancel-target'; started.calibration.status = 'collecting'
    vi.mocked(gazeRequest).mockImplementation(action => action === 'start' ? Promise.resolve(started) : action === 'target'
      ? new Promise(resolve => { resolveTarget = resolve }) : Promise.resolve(initial()))
    await render()
    await click('Set up gaze')
    await act(async () => vi.advanceTimersByTimeAsync(40))
    await click('Cancel setup')
    await act(async () => resolveTarget({ ...started, calibration: { ...started.calibration, collecting: true } }))
    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(host.querySelector('dialog')).toBeNull()
    expect(vi.mocked(gazeRequest).mock.calls.filter(([action]) => action === 'target')).toHaveLength(1)
    expect(vi.mocked(gazeRequest).mock.calls).toContainEqual(['reset', { calibration_id: 'cancel-target' }])
  })
})
