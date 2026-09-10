import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { request } from '../src/api'
import type { AppState, CameraStatus, StudySession } from '../src/types'
import Dashboard from './Dashboard'

vi.mock('../components/GazePanel', () => ({ default: () => null }))
vi.mock('../src/api', () => ({ request: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function state(status: CameraStatus): AppState {
  return { active: null, state: 'unknown', history: [], preview_active: status !== 'off', observation: { camera_status: status, available: status === 'ready', face_count: status === 'ready' ? 1 : null, pitch: null, yaw: null, roll: null, message: status === 'unavailable' ? 'Select Retry camera.' : `Camera ${status}.` } }
}

function activeState(camera = false, status: 'running' | 'break' = 'running'): AppState {
  const session: StudySession = { id: 'session-1', task: 'Algebra', mode: 'Math', started_at: new Date().toISOString(), ended_at: null,
    camera_enabled: camera, status, elapsed: 80, timeline: [{ start: 0, end: 80, state: 'unknown' }],
    totals: { present: 0, away: 0, unknown: 80, break: 0 }, longest_present: 0 }
  return { ...state(camera && status === 'running' ? 'ready' : 'off'), active: session, preview_active: false, state: status === 'break' ? 'break' : 'unknown' }
}

describe('Dashboard camera controls', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    vi.resetAllMocks()
    vi.restoreAllMocks()
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal')
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'close')
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('shows starting in both panels and does not send repeated retries', async () => {
    vi.mocked(request).mockImplementation(async path => state(path ? 'starting' : 'off'))
    await act(async () => root.render(<Dashboard />))
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    expect(host.textContent?.match(/Camera: Starting/g)).toHaveLength(2)
    const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'Starting camera…')!
    expect(retry.disabled).toBe(true)
    await act(async () => { retry.click(); retry.click() })
    expect(vi.mocked(request).mock.calls.filter(([path]) => path === '/api/camera/preview/start')).toHaveLength(1)
  })

  it('honors closing a preview while the start request is pending', async () => {
    let completeStart!: (value: AppState) => void
    vi.mocked(request).mockImplementation(path => path === '/api/camera/preview/start'
      ? new Promise(resolve => { completeStart = resolve }) : Promise.resolve(state('off')))
    await act(async () => root.render(<Dashboard />))
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close camera preview"]')!.click())
    expect(host.querySelector('[aria-labelledby="preview-title"]')).toBeNull()
    await act(async () => completeStart(state('starting')))
    expect(vi.mocked(request).mock.calls.map(([path]) => path)).toContain('/api/camera/preview/stop')
    expect(host.querySelector('[aria-labelledby="preview-title"]')).toBeNull()
    expect(host.textContent).toContain('Camera: Off')
  })

  const clickButton = async (host: HTMLElement, text: string) => {
    const button = [...host.querySelectorAll('button')].find(item => item.textContent?.includes(text))!
    expect(button).toBeTruthy()
    await act(async () => button.click())
  }

  it('preserves setup input after a failed start and prevents duplicate submission', async () => {
    let rejectStart!: (error: Error) => void
    vi.mocked(request).mockImplementation(path => path === '/api/sessions/start'
      ? new Promise((_resolve, reject) => { rejectStart = reject }) : Promise.resolve(state('off')))
    await act(async () => root.render(<Dashboard />))
    const input = host.querySelector<HTMLInputElement>('#task')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Read chapter 4')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await clickButton(host, 'Start session')
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(vi.mocked(request).mock.calls.filter(([path]) => path === '/api/sessions/start')).toHaveLength(1)
    expect(host.textContent).toContain('Starting session…')
    expect(host.textContent).not.toContain('Saving session…')
    await act(async () => rejectStart(new Error('Unable to start')))
    expect(input.value).toBe('Read chapter 4')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Unable to start')
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false)
  })

  it('keeps the active session on save failure and opens a report after retry succeeds', async () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true } })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false } })
    const current = activeState()
    const saved: StudySession = { ...current.active!, status: 'completed', ended_at: new Date().toISOString() }
    let fail = true
    vi.mocked(request).mockImplementation(async path => {
      if (path === '/api/sessions/end') {
        if (fail) throw new Error('Save failed; retry')
        return { ...state('off'), history: [saved], finished: saved }
      }
      return current
    })
    await act(async () => root.render(<Dashboard />))
    await clickButton(host, 'End & save session')
    expect(host.querySelector('[role="timer"]')?.textContent).toBe('00:01:20')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Save failed')
    fail = false
    await clickButton(host, 'End & save session')
    const dialog = host.querySelector('dialog')!
    expect(dialog.open).toBe(true)
    expect(dialog.textContent).toContain('Observation coverage')
    expect(dialog.textContent).toContain('0%')
    await act(async () => dialog.dispatchEvent(new Event('cancel', { cancelable: true })))
    expect(host.querySelector('dialog')).toBeNull()
    expect(host.querySelector('#task')).toBe(document.activeElement)
  })

  it('recovers a running session after connection loss', async () => {
    let fail = false
    let current = activeState()
    vi.mocked(request).mockImplementation(async () => {
      if (fail) throw new Error('Disconnected')
      return current
    })
    await act(async () => root.render(<Dashboard />))
    expect(host.querySelector('[role="timer"]')?.textContent).toBe('00:01:20')
    fail = true
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(host.textContent).toContain('Last received time')
    expect([...host.querySelectorAll('button')].find(button => button.textContent?.includes('End & save'))?.disabled).toBe(true)
    fail = false
    current = { ...current, active: { ...current.active!, elapsed: 90 } }
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(host.querySelector('[role="timer"]')?.textContent).toBe('00:01:30')
    expect(host.querySelector('#task')).toBeNull()
    expect(host.textContent).not.toContain('Last received time')
  })

  it('toggles observations without changing the timer and closes the preview on disable', async () => {
    let current = activeState()
    vi.mocked(request).mockImplementation(async (path, body) => {
      if (path === '/api/sessions/camera') current = activeState((body as { enabled: boolean }).enabled)
      return current
    })
    await act(async () => root.render(<Dashboard />))
    const checkbox = host.querySelector<HTMLInputElement>('.live-camera-control input')!
    await act(async () => checkbox.click())
    expect(checkbox.checked).toBe(true)
    expect(host.querySelector('[aria-labelledby="preview-title"]')).not.toBeNull()
    expect(host.querySelector('[role="timer"]')?.textContent).toBe('00:01:20')
    await act(async () => checkbox.click())
    expect(checkbox.checked).toBe(false)
    expect(host.querySelector('[aria-labelledby="preview-title"]')).toBeNull()
    expect(host.textContent).toContain('this time is marked unknown')
    expect(vi.mocked(request).mock.calls.filter(([path]) => path === '/api/sessions/camera')).toHaveLength(2)
  })

  it('ignores a poll started before a camera command', async () => {
    let resolvePoll!: (value: AppState) => void
    vi.mocked(request).mockResolvedValueOnce(activeState())
      .mockImplementationOnce(() => new Promise(resolve => { resolvePoll = resolve }))
      .mockResolvedValue(activeState(true))
    await act(async () => root.render(<Dashboard />))
    await act(async () => { vi.advanceTimersByTime(1000) })
    await act(async () => host.querySelector<HTMLInputElement>('.live-camera-control input')!.click())
    await act(async () => resolvePoll(activeState()))
    expect(host.querySelector<HTMLInputElement>('.live-camera-control input')?.checked).toBe(true)
    expect(host.textContent).toContain('Camera: Ready')
  })

  it('retains the server camera setting on command failure', async () => {
    vi.mocked(request).mockImplementation(async path => {
      if (path === '/api/sessions/camera') throw new Error('Camera setting could not be saved')
      return activeState(true)
    })
    await act(async () => root.render(<Dashboard />))
    await act(async () => host.querySelector<HTMLInputElement>('.live-camera-control input')!.click())
    expect(host.querySelector<HTMLInputElement>('.live-camera-control input')?.checked).toBe(true)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not be saved')
    expect(host.querySelector('[role="timer"]')?.textContent).toBe('00:01:20')
  })

  it('keeps the preview closed when camera settings change during a break', async () => {
    let current = activeState(false, 'break')
    vi.mocked(request).mockImplementation(async (path, body) => {
      if (path === '/api/sessions/camera') current = activeState((body as { enabled: boolean }).enabled, 'break')
      if (path === '/api/sessions/resume') current = activeState(true)
      return current
    })
    await act(async () => root.render(<Dashboard />))
    await act(async () => host.querySelector<HTMLInputElement>('.live-camera-control input')!.click())
    expect(host.textContent).toContain('Observations will resume with your session')
    expect(host.querySelector('[aria-labelledby="preview-title"]')).toBeNull()
    await clickButton(host, 'Resume session')
    expect(host.querySelector('[aria-labelledby="preview-title"]')).not.toBeNull()
    expect(host.textContent).not.toContain('Saving session…')
  })
})
