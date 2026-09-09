import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CameraPreview from './CameraPreview'
import type { CameraStatus } from '../src/types'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('Camera preview recovery', () => {
  let host: HTMLDivElement
  let root: Root
  const onRetry = vi.fn()
  const onClose = vi.fn()
  const fetchFrame = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    vi.stubGlobal('fetch', fetchFrame.mockResolvedValue(new Response(null, { status: 204 })))
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:camera-frame')
      static revokeObjectURL = vi.fn()
    })
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
  async function render(status: CameraStatus) {
    await act(async () => root.render(<CameraPreview status={status} message="Check camera access, then select Retry camera." inSession onClose={onClose} onRetry={onRetry} busy={false} />))
  }

  it('blocks retries during startup and enables recovery after failure', async () => {
    await render('starting')
    const retry = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Starting camera'))!
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Camera: Starting')
    expect(retry.disabled).toBe(true)
    await act(async () => retry.click())
    expect(onRetry).not.toHaveBeenCalled()
    await render('unavailable')
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Camera: Unavailable')
    expect(retry.disabled).toBe(false)
    await act(async () => retry.click())
    expect(onRetry).toHaveBeenCalledOnce()
    expect(host.textContent).toContain('Your timer keeps running through camera errors')
  })

  it('hides stale images immediately and releases the last frame on close', async () => {
    fetchFrame.mockImplementation(async () => new Response(new Blob(['frame']), { headers: { 'Content-Type': 'image/jpeg' } }))
    await render('ready')
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:camera-frame')
    await render('unavailable')
    expect(host.querySelector('img')).toBeNull()
    await act(async () => root.render(null))
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:camera-frame')
  })

  it('clears the frame on a connection failure', async () => {
    fetchFrame.mockImplementationOnce(async () => new Response(new Blob(['frame']), { headers: { 'Content-Type': 'image/jpeg' } }))
    await render('ready')
    fetchFrame.mockRejectedValueOnce(new Error('Connection lost'))
    await act(async () => vi.advanceTimersByTimeAsync(200))
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Camera: Unavailable')
    expect(host.textContent).toContain('connection lost')
  })

  it('supports Escape and restores keyboard focus', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    await render('off')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close camera preview')
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(onClose).toHaveBeenCalledOnce()
    await act(async () => root.render(null))
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})
