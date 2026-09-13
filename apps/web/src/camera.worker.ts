/// <reference lib="webworker" />
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
let detector: FaceLandmarker | null = null
self.onmessage = async (event: MessageEvent) => {
  const { type, bitmap, timestamp, base } = event.data
  try {
    if (type === 'init') {
      const files = await FilesetResolver.forVisionTasks(`${base}/wasm`)
      detector = await FaceLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: `${base}/models/face_landmarker.task`, delegate: 'CPU' }, runningMode: 'VIDEO', numFaces: 2, outputFaceBlendshapes: false, outputFacialTransformationMatrixes: false })
      self.postMessage({ type: 'ready' })
    } else if (type === 'frame' && detector) {
      const result = detector.detectForVideo(bitmap, timestamp)
      // Return only face count. Meshes never leave this worker.
      self.postMessage({ type: 'observation', faceCount: result.faceLandmarks.length, timestamp })
    }
  } catch { self.postMessage({ type: 'error', message: 'Tracking could not start. Retry or continue without the camera.' }) }
  finally { bitmap?.close() }
}
