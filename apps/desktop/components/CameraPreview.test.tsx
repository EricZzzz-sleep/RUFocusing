import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CameraPreview from './CameraPreview'
import type { CameraStatus, PreviewPosition } from '../src/types'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('Camera preview recovery', () => {
  let host: HTMLDivElement
  let root: Root
  const onRetry = vi.fn()
  const onClose = vi.fn()
  const fetchFrame = vi.fn()
  const onPositionChange = vi.fn()

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
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
  async function render(status: CameraStatus, position: PreviewPosition | null = null) {
    await act(async () => root.render(<CameraPreview position={position} onPositionChange={onPositionChange} status={status} message="Check camera access, then select Retry camera." inSession onClose={onClose} onRetry={onRetry} busy={false} />))
  }


  function geometry() {
    vi.stubGlobal('innerWidth', 1000); vi.stubGlobal('innerHeight', 800)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const x = parseFloat(this.style.left) || 0, y = parseFloat(this.style.top) || 0
      return { x, y, left: x, top: y, right: x + 390, bottom: y + 400, width: 390, height: 400, toJSON: () => ({}) }
    })
  }
  const location = () => {
    const panel = host.querySelector<HTMLElement>('.camera-preview')!
    return { x: parseFloat(panel.style.left), y: parseFloat(panel.style.top) }
  }
  async function pointer(type: string, x: number, y: number, pointerType = 'mouse') {
    const handle = host.querySelector<HTMLButtonElement>('.preview-drag-handle')!
    const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true })
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: pointerType } })
    await act(async () => handle.dispatchEvent(event))
  }

  it('moves with keyboard, clamps to the viewport, and restores the default position', async () => {
    geometry()
    await render('off')
    expect(location()).toEqual({ x: 586, y: 376 })
    const handle = host.querySelector<HTMLButtonElement>('.preview-drag-handle')!
    handle.focus()
    await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    expect(location().x).toBe(576)
    await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true })))
    expect(location().y).toBe(336)
    await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    expect(location()).toEqual({ x: 586, y: 376 })
    await act(async () => { vi.stubGlobal('innerWidth', 600); vi.stubGlobal('innerHeight', 500); window.dispatchEvent(new Event('resize')) })
    expect(location()).toEqual({ x: 194, y: 84 })
    expect(fetchFrame).toHaveBeenCalledOnce()
  })

  it.each(['mouse', 'touch', 'pen'])('drags with %s and ends movement on cancellation', async pointerType => {
    geometry()
    await render('ready')
    const handle = host.querySelector<HTMLButtonElement>('.preview-drag-handle')!
    handle.setPointerCapture = vi.fn()
    handle.hasPointerCapture = vi.fn(() => true)
    handle.releasePointerCapture = vi.fn()
    await pointer('pointerdown', 600, 390, pointerType)
    await pointer('pointermove', -1000, -1000, pointerType)
    expect(location()).toEqual({ x: 16, y: 16 })
    expect(handle.setPointerCapture).toHaveBeenCalledWith(1)
    await pointer('pointercancel', 0, 0, pointerType)
    await pointer('pointermove', 100, 100, pointerType)
    expect(location()).toEqual({ x: 16, y: 16 })
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1)
    expect(fetchFrame).toHaveBeenCalledOnce()
    const mirror = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await act(async () => mirror.click())
    expect(mirror.checked).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('restores the remembered position after reopening and clamps resized content', async () => {
    geometry()
    await render('off', { x: 70, y: 90 })
    expect(location()).toEqual({ x: 70, y: 90 })
    await act(async () => root.render(null))
    await render('off', { x: 900, y: 700 })
    expect(location()).toEqual({ x: 594, y: 384 })
    expect(onPositionChange).toHaveBeenLastCalledWith({ x: 594, y: 384 })
  })

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
