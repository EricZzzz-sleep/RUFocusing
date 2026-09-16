import { useEffect, useRef, useState } from 'react'
import { AwayDetector } from '../../../packages/study'
import type { SessionController } from './session'
import { preference, savePreference } from './api'

export default function Camera({ controller }: { controller: SessionController }) {
  const video = useRef<HTMLVideoElement>(null)
  const [status, setStatus] = useState('Camera is off.'), [ready, setReady] = useState(false)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [device, setDevice] = useState(() => preference('camera-device'))
  const [attempt, setAttempt] = useState(0), [preview, setPreview] = useState(true)
  const ctrl = useRef(controller); ctrl.current = controller
  useEffect(() => {
    if (!controller.observing) { setStatus(controller.active?.status === 'break' ? 'Camera paused during break.' : 'Camera is off.'); setReady(false); return }
    let disposed = false, failed = false, stream: MediaStream | null = null, worker: Worker | null = null, inFlight = false, booted = false
    let lastTimestamp = 0, lastFace: number | null = null, frameSentAt = 0
    const detector = new AwayDetector()
    const markUnknown = () => { lastFace = null; detector.reset(); ctrl.current.buffer.observe(ctrl.current.elapsed(), 'unknown') }
    const stopMedia = () => { stream?.getTracks().forEach(track => track.stop()); if (video.current) video.current.srcObject = null; worker?.terminate(); worker = null; booted = false; markUnknown() }
    const fail = (message: string) => { if (!disposed && !failed) { failed = true; setStatus(message); setReady(false); stopMedia() } }
    setStatus('Starting camera…'); setReady(false)
    const startup = setTimeout(() => fail('Camera setup timed out. Retry or continue without the camera.'), 15000)
    const ended = () => fail('Camera access ended. Check permissions and retry.')
    const visibility = () => { if (document.hidden) markUnknown() }
    document.addEventListener('visibilitychange', visibility)
    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported')
        const media = await navigator.mediaDevices.getUserMedia({ video: device ? { deviceId: { exact: device }, width: { ideal: 640 }, height: { ideal: 480 } } : { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false })
        if (disposed || failed) { media.getTracks().forEach(track => track.stop()); return }
        stream = media
        stream.getVideoTracks().forEach(track => track.addEventListener('ended', ended))
        if (video.current) { video.current.srcObject = stream; await video.current.play() }
        if (disposed || failed) return
        const available = await navigator.mediaDevices.enumerateDevices()
        if (disposed || failed) return
        setDevices(available.filter(item => item.kind === 'videoinput'))
        worker = new Worker('/tracking/camera.js')
        worker.onmessage = event => {
          if (disposed || failed) return
          if (event.data.type === 'ready') { clearTimeout(startup); booted = true; setReady(true); setStatus('Tracking presence. No video is saved or uploaded.') }
          if (event.data.type === 'observation') { inFlight = false; lastFace = event.data.faceCount; lastTimestamp = event.data.timestamp / 1000 }
          if (event.data.type === 'error') fail(event.data.message)
        }
        worker.onerror = () => fail('Tracking stopped. Retry or continue without the camera.')
        worker.postMessage({ type: 'init', base: location.origin })
      } catch (e) {
        const name = e && typeof e === 'object' && 'name' in e ? e.name : ''
        fail(name === 'NotAllowedError' ? 'Camera permission was denied. Allow camera access in your browser, then retry.' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'Camera not found. Select another camera or continue without tracking.' : 'Camera unavailable. Check access and retry, or continue without tracking.')
      }
    })()
    const interval = setInterval(async () => {
      if (disposed || failed) return
      const now = performance.now()
      ctrl.current.buffer.observe(ctrl.current.elapsed(), document.hidden ? 'unknown' : detector.classify(lastFace, lastTimestamp, now / 1000))
      if (inFlight && now - frameSentAt > 3000) { fail('Tracking stopped responding. Retry or continue without tracking.'); return }
      if (!booted || !worker || inFlight || document.hidden || !video.current || video.current.readyState < 2) return
      inFlight = true; frameSentAt = now
      try {
        const bitmap = await createImageBitmap(video.current)
        if (disposed || failed || !worker) { bitmap.close(); return }
        worker.postMessage({ type: 'frame', bitmap, timestamp: now }, [bitmap])
      } catch { inFlight = false; markUnknown() }
    }, 200)
    return () => { disposed = true; clearTimeout(startup); clearInterval(interval); document.removeEventListener('visibilitychange', visibility); stopMedia() }
  }, [controller.observing, device, attempt])
  return <section className="panel web-camera" aria-labelledby="camera-heading"><div className="panel-heading"><h2 id="camera-heading">Camera</h2><span className="small-badge">Optional</span></div>
    <p className="muted">Presence estimates run in your browser. Video and face landmarks are never uploaded.</p>
    <div className="camera-toolbar"><label className="checkbox-label"><input type="checkbox" checked={controller.active?.camera_enabled ?? false} disabled={!controller.active || controller.busy || Boolean(controller.retry) || !controller.connected || (controller.active.status === 'running' && !controller.owned)} onChange={event => void controller.command('camera', { enabled: event.target.checked }).catch(() => {})}/>Use camera</label>
      <button className="text-button" onClick={() => setPreview(value => !value)}>{preview ? 'Hide preview' : 'Show preview'}</button>
    </div>
    <div className={preview ? 'web-video' : 'web-video visually-hidden'}><video ref={video} muted playsInline aria-label="Live camera preview" />{!ready && <p>{status}</p>}</div>
    <p role="status">{status}</p>
    {(devices.length > 0 || device) && <label>Camera device<select value={device} onChange={event => { setDevice(event.target.value); savePreference('camera-device', event.target.value) }}><option value="">Default camera</option>{device && !devices.some(item => item.deviceId === device) && <option value={device}>Previously selected camera</option>}{devices.map(item => <option key={item.deviceId} value={item.deviceId}>{item.label || 'Camera'}</option>)}</select></label>}
    {device && !ready && <button className="button secondary" onClick={() => { setDevice(''); savePreference('camera-device', '') }}>Use default camera</button>}
    {controller.observing && !ready && <button className="button secondary" onClick={() => setAttempt(value => value + 1)}>Retry camera</button>}
  </section>
}
