import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { request } from '../src/api'
import type { AppState, CameraStatus } from '../src/types'
import Dashboard from './Dashboard'

vi.mock('../src/api', () => ({ request: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function state(status: CameraStatus): AppState {
  return { active: null, state: 'unknown', history: [], preview_active: status !== 'off', observation: { camera_status: status, available: status === 'ready', face_count: status === 'ready' ? 1 : null, pitch: null, yaw: null, roll: null, message: status === 'unavailable' ? 'Select Retry camera.' : `Camera ${status}.` } }
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
})
