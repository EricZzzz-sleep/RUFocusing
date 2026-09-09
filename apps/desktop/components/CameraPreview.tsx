import { useEffect, useRef, useState } from 'react'
import { cameraStatusLabels } from '../src/types'
import type { CameraStatus } from '../src/types'

interface Props {
  message: string
  status: CameraStatus
  inSession: boolean
  onClose: () => void
  onRetry: () => void
  busy: boolean
}

export default function CameraPreview({ message, status, inSession, onClose, onRetry, busy }: Props) {
  const [image, setImage] = useState('')
  const [mirrored, setMirrored] = useState(true)
  const [frameError, setFrameError] = useState('')
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    closeButton.current?.focus()
    return () => { if (previousFocus?.isConnected) previousFocus.focus() }
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
  return <section className="camera-preview" role="dialog" aria-modal="false" aria-labelledby="preview-title" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <div className="preview-heading"><div><span className="eyebrow">PREVIEW · NOT SAVED</span><h2 id="preview-title">Camera preview</h2></div><button ref={closeButton} type="button" className="icon-button" aria-label="Close camera preview" onClick={onClose}>×</button></div>
    <div className="preview-status"><span className={`camera-status ${displayStatus}`} role="status">Camera: {cameraStatusLabels[displayStatus]}</span></div>
    <div className="preview-image-area">
      {image && displayStatus === 'ready' ? <img src={image} alt="Live view from the same webcam used for face and head-pose detection" className={mirrored ? 'mirrored' : ''} /> : <div className="preview-placeholder"><span aria-hidden="true">◎</span><p>{frameError || message || 'Starting your camera…'}</p></div>}
    </div>
    <div className="preview-caption"><p>Adjust your camera or position until the view looks right.</p><div className="preview-options"><label className="checkbox-label"><input type="checkbox" checked={mirrored} onChange={event => setMirrored(event.target.checked)} />Mirror preview</label><button type="button" className="text-button" onClick={onRetry} disabled={busy || status === 'starting'}>{status === 'starting' ? 'Starting camera…' : 'Retry camera'}</button></div><span>{inSession ? 'Your timer keeps running through camera errors. Closing this preview keeps session tracking on.' : 'Preview only. Your session timer has not started.'}</span></div>
  </section>
}
