import { jsonRequest } from './api'
import type { GazeState } from './types'
export const gazeRequest = (action?: string, body: object = {}) => action
  ? jsonRequest<GazeState>(`/api/gaze/calibration/${action}`, body)
  : jsonRequest<GazeState>('/api/gaze/state' + ('calibration_id' in body && typeof body.calibration_id === 'string' ? `?calibration_id=${encodeURIComponent(body.calibration_id)}` : ''))
