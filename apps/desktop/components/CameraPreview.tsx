import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cameraStatusLabels } from '../src/types'
import type { CameraStatus, PreviewPosition } from '../src/types'

interface Props {
  position?: PreviewPosition | null
  onPositionChange?: (position: PreviewPosition) => void
  message: string
  status: CameraStatus
  inSession: boolean
  onClose: () => void
  onRetry: () => void
  busy: boolean
}

export default function CameraPreview({ message, status, inSession, onClose, onRetry, busy, position = null, onPositionChange }: Props) {
  const [image, setImage] = useState('')
  const [mirrored, setMirrored] = useState(true)
  const [frameError, setFrameError] = useState('')
  const closeButton = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  const handle = useRef<HTMLButtonElement>(null)
  const [location, setLocation] = useState<PreviewPosition | null>(position)
  const locationRef = useRef(location)
  const changeRef = useRef(onPositionChange)
  changeRef.current = onPositionChange
  const drag = useRef<{ id: number; x: number; y: number; origin: PreviewPosition } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight })

  function move(wanted: PreviewPosition | null) {
    const rect = panel.current?.getBoundingClientRect()
    if (!rect) return
    const view = window.visualViewport
    const width = view?.width ?? window.innerWidth, height = view?.height ?? window.innerHeight
    const left = (view?.offsetLeft ?? 0), top = (view?.offsetTop ?? 0)
    const edge = width <= 520 ? 16 : 24
    const x = Math.max(left + 16, Math.min(wanted?.x ?? left + width - rect.width - edge, left + width - rect.width - 16))
    const y = Math.max(top + 16, Math.min(wanted?.y ?? top + height - rect.height - edge, top + height - rect.height - 16))
    if (locationRef.current?.x !== x || locationRef.current?.y !== y) {
      const next = { x, y }
      locationRef.current = next; setLocation(next); changeRef.current?.(next)
    }
  }
  function releaseDrag() {
    const id = drag.current?.id
    drag.current = null
    if (id != null && handle.current?.hasPointerCapture?.(id)) handle.current.releasePointerCapture(id)
    setDragging(false)
  }
  useLayoutEffect(() => {
    const resize = () => {
      const view = window.visualViewport
      setViewport({ width: view?.width ?? window.innerWidth, height: view?.height ?? window.innerHeight })
      move(locationRef.current)
    }
    resize()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    if (panel.current) observer?.observe(panel.current)
    window.addEventListener('resize', resize)
    window.visualViewport?.addEventListener('resize', resize)
    window.visualViewport?.addEventListener('scroll', resize)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', resize)
      window.visualViewport?.removeEventListener('resize', resize)
      window.visualViewport?.removeEventListener('scroll', resize)
      const id = drag.current?.id
      drag.current = null
      if (id != null && handle.current?.hasPointerCapture?.(id)) handle.current.releasePointerCapture(id)
    }
  }, [])
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    closeButton.current?.focus()
    return () => { if (previousFocus?.isConnected && !previousFocus.closest('[hidden]')) previousFocus.focus() }
  }, [])

  useEffect(() => {
    let stopped = false
    let url = ''
    let timeout: ReturnType<typeof setTimeout>
    let controller: AbortController | undefined
    function clearImage() {
      if (url) URL.revokeObjectURL(url)
      url = ''
      if (!stopped) setImage('')
    }
    async function poll() {
      controller = new AbortController()
      const abort = setTimeout(() => controller?.abort(), 4000)
      try {
        const response = await fetch('/api/camera/preview', { headers: { 'X-RUFocusing': '1' }, cache: 'no-store', signal: controller.signal })
        if (stopped) return
        if (response.status === 204) { clearImage(); setFrameError('') }
        else if (response.ok && response.headers.get('content-type')?.includes('image/jpeg')) {
          const blob = await response.blob()
          if (stopped) return
          const next = URL.createObjectURL(blob)
          if (url) URL.revokeObjectURL(url)
          url = next
          setImage(next); setFrameError('')
        } else { clearImage(); setFrameError('Preview unavailable. Select Retry camera. If it persists, check the local service connection.') }
      } catch {
        if (!stopped) { clearImage(); setFrameError('Camera preview connection lost. Check the local service connection, then select Retry camera.') }
      } finally {
        clearTimeout(abort)
        if (!stopped) timeout = setTimeout(poll, 200)
      }
    }
    void poll()
    return () => { stopped = true; clearTimeout(timeout); controller?.abort(); clearImage() }
  }, [])

  const displayStatus = frameError ? 'unavailable' : status
  return <section ref={panel} className={`camera-preview${dragging ? ' is-dragging' : ''}`} style={{ left: location?.x, top: location?.y, right: location ? 'auto' : undefined, bottom: location ? 'auto' : undefined, width: Math.min(390, viewport.width - 32), maxHeight: viewport.height - 32 }} role="dialog" aria-modal="false" aria-labelledby="preview-title" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <div className="preview-heading"><button ref={handle} type="button" className="preview-drag-handle" aria-label="Move camera preview" aria-describedby="preview-move-help"
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0) return
        const rect = panel.current!.getBoundingClientRect()
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: { x: rect.left, y: rect.top } }
        event.currentTarget.setPointerCapture(event.pointerId); setDragging(true)
      }}
      onPointerMove={event => {
        const current = drag.current
        if (current?.id === event.pointerId) move({ x: current.origin.x + event.clientX - current.x, y: current.origin.y + event.clientY - current.y })
      }}
      onPointerUp={event => { if (drag.current?.id === event.pointerId) releaseDrag() }}
      onPointerCancel={event => { if (drag.current?.id === event.pointerId) releaseDrag() }}
      onLostPointerCapture={() => { drag.current = null; setDragging(false) }}
      onKeyDown={event => {
        const offsets: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
        if (event.key === 'Home') { event.preventDefault(); releaseDrag(); move(null); return }
        const offset = offsets[event.key]
        if (!offset) return
        event.preventDefault()
        const rect = panel.current!.getBoundingClientRect(), step = event.shiftKey ? 40 : 10
        move({ x: rect.left + offset[0] * step, y: rect.top + offset[1] * step })
      }}><span aria-hidden="true">⠿</span></button><div><span className="eyebrow">PREVIEW · NOT SAVED</span><h2 id="preview-title">Camera preview</h2></div><button ref={closeButton} type="button" className="icon-button" aria-label="Close camera preview" onClick={onClose}>×</button></div>
    <p id="preview-move-help" className="sr-only">Drag to move. Or use arrow keys to move 10 pixels, Shift and arrows for 40 pixels, and Home to reset position.</p>
    <div className="preview-status"><span className={`camera-status ${displayStatus}`} role="status">Camera: {cameraStatusLabels[displayStatus]}</span></div>
    <div className="preview-image-area">
      {image && displayStatus === 'ready' ? <img src={image} alt="Live view from the same webcam used for face and head-pose detection" className={mirrored ? 'mirrored' : ''} /> : <div className="preview-placeholder"><span aria-hidden="true">◎</span><p>{frameError || message || 'Starting your camera…'}</p></div>}
    </div>
    <div className="preview-caption"><p>Adjust your camera or position until the view looks right.</p><div className="preview-options"><label className="checkbox-label"><input type="checkbox" checked={mirrored} onChange={event => setMirrored(event.target.checked)} />Mirror preview</label><button type="button" className="text-button" onClick={onRetry} disabled={busy || status === 'starting'}>{status === 'starting' ? 'Starting camera…' : 'Retry camera'}</button></div><span>{inSession ? 'Your timer keeps running through camera errors. Closing this preview keeps session tracking on.' : 'Preview only. Your session timer has not started.'}</span></div>
  </section>
}
