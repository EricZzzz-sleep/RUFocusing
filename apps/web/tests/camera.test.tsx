// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Camera from '../src/Camera'
import type { SessionController } from '../src/session'

const preferences = vi.hoisted(() => new Map<string, string>())
vi.mock('../src/api', () => ({
  preference: (key: string) => preferences.get(key) ?? '',
  savePreference: (key: string, value: string) => preferences.set(key, value),
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root, host: HTMLDivElement, getUserMedia: ReturnType<typeof vi.fn>
let stop: ReturnType<typeof vi.fn>, terminate: ReturnType<typeof vi.fn>
let controller: SessionController
beforeEach(() => {
  vi.useFakeTimers(); preferences.clear()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  stop = vi.fn(); terminate = vi.fn()
  const track = { stop, addEventListener: vi.fn() }
  getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [track], getVideoTracks: () => [track] })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]) } })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  vi.stubGlobal('Worker', class {
    onmessage?: (event: { data: { type: string } }) => void
    terminate = terminate
    postMessage() { this.onmessage?.({ data: { type: 'ready' } }) }
  })
  controller = { observing: true, active: { status: 'running', camera_enabled: true }, busy: false, connected: true, owned: true,
    buffer: { observe: vi.fn() }, elapsed: () => 0, command: vi.fn().mockResolvedValue({}) } as unknown as SessionController
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})
async function render() { await act(async () => root.render(<Camera controller={controller}/>)) }
const button = (label: string) => [...host.querySelectorAll('button')].find(node => node.textContent === label)!
it('recovers from a disconnected saved device before devices can be enumerated', async () => {
  preferences.set('camera-device', 'disconnected')
  getUserMedia.mockRejectedValueOnce(new DOMException('Not connected', 'OverconstrainedError'))
  await render()
  expect(host.textContent).toContain('Camera not found')
  expect(host.querySelector('select')!.value).toBe('disconnected')
  await act(async () => button('Use default camera').click())
  expect(getUserMedia).toHaveBeenCalledTimes(2)
  expect(getUserMedia.mock.calls[1][0].video.deviceId).toBeUndefined()
  expect(preferences.get('camera-device')).toBe('')
  expect(host.textContent).toContain('Tracking presence.')
})
it('releases capture and inference on break, restarts on resume, and releases on end', async () => {
  await render(); expect(getUserMedia).toHaveBeenCalledTimes(1)
  await act(async () => button('Hide preview').click())
  expect(stop).not.toHaveBeenCalled(); expect(getUserMedia).toHaveBeenCalledTimes(1)
  controller = { ...controller, observing: false, active: { ...controller.active!, status: 'break' } }
  await render(); expect(stop).toHaveBeenCalledTimes(1); expect(terminate).toHaveBeenCalledTimes(1)
  controller = { ...controller, observing: true, active: { ...controller.active!, status: 'running' } }
  await render(); expect(getUserMedia).toHaveBeenCalledTimes(2)
  await act(async () => root.render(null))
  expect(stop).toHaveBeenCalledTimes(2); expect(terminate).toHaveBeenCalledTimes(2)
})
it('releases a permission request that resolves after tracking was disabled', async () => {
  let resolve!: (stream: object) => void
  getUserMedia.mockImplementationOnce(() => new Promise(yes => { resolve = yes }))
  await render()
  controller = { ...controller, observing: false }; await render()
  await act(async () => resolve({ getTracks: () => [{ stop }] }))
  expect(stop).toHaveBeenCalledTimes(1)
  expect(host.querySelector('video')!.srcObject).toBeNull()
})
