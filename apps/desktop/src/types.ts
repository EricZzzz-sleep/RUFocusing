export type Presence = 'present' | 'away' | 'break' | 'unknown'
export type CameraStatus = 'off' | 'starting' | 'ready' | 'unavailable'
export const studyModes = ['Math', 'Coding', 'Reading', 'Lecture'] as const
export const cameraStatusLabels: Record<CameraStatus, string> = { off: 'Off', starting: 'Starting', ready: 'Ready', unavailable: 'Unavailable' }
export interface Interval { start: number; end: number; state: Presence }
export interface StudySession {
  id: string; task: string; mode: string; started_at: string; ended_at: string | null
  status: 'running' | 'break' | 'completed' | 'interrupted'
  camera_enabled: boolean; elapsed: number; timeline: Interval[]
  totals: Record<Presence, number>; longest_present: number
  gaze_summary?: GazeSummary | null
  analysis_summary?: AnalysisSummary
}
export interface AppState {
  active: StudySession | null; state: Presence; history: StudySession[]
  observation: { camera_status: CameraStatus; available: boolean; face_count: number | null; pitch: number | null; yaw: number | null; roll: number | null; message: string }
  preview_active: boolean
  finished?: StudySession | null
}
export const labels: Record<Presence, string> = { present: 'At desk', away: 'Away', break: 'Break', unknown: 'Unknown' }
export function duration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const secs = whole % 60
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${secs}s` : `${secs}s`
}
export function timer(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 3600).toString().padStart(2, '0')}:${Math.floor((whole % 3600) / 60).toString().padStart(2, '0')}:${(whole % 60).toString().padStart(2, '0')}`
}
export const dateLabel = (timestamp: string) => new Date(timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export type GazeRegion = 'top_left' | 'top_center' | 'top_right' | 'middle_left' | 'middle_center' | 'middle_right' | 'bottom_left' | 'bottom_center' | 'bottom_right'
export type CalibrationStatus = 'uncalibrated' | 'collecting' | 'validating' | 'ready' | 'failed'
export interface DisplayGeometry { width: number; height: number; device_pixel_ratio: number }
export interface GazeValidation { median_error: number | null; p90_error: number | null; accepted: boolean; unit: 'display_diagonal_fraction' }
export interface GazeObservation { timestamp: number; valid: boolean; x: number | null; y: number | null; region: GazeRegion | null; reason: string; calibration_id: string | null }
export interface GazeState {
  experimental: boolean
  diagnostic_check_active?: boolean
  quality: string
  observation: GazeObservation
  calibration: {
    id: string | null; status: CalibrationStatus; reason: string; display: DisplayGeometry | null; validation: GazeValidation | null
    target_index: number | null; target: [number, number] | null; target_count: number; targets: [number, number][]
    rejections?: Record<string, number>
    completed_targets: number; samples: number; collecting: boolean; target_error: string | null
  }
}
export interface GazeSummary { totals: Partial<Record<GazeRegion | 'unknown' | 'break', number>>; tracked: number; study: number; coverage: number | null }
export interface GazeDetails {
  session_id: string; summary: GazeSummary | null
  intervals: { start: number; end: number; state: GazeRegion | 'unknown' | 'break'; calibration_id: string | null }[]
  calibrations: { id: string; model_version: string; display: DisplayGeometry; validation: GazeValidation }[]
}
export const gazeRegionLabels: Record<GazeRegion, string> = {
  top_left: 'Top left', top_center: 'Top center', top_right: 'Top right',
  middle_left: 'Middle left', middle_center: 'Center', middle_right: 'Middle right',
  bottom_left: 'Bottom left', bottom_center: 'Bottom center', bottom_right: 'Bottom right',
}

export type WorkspacePage = 'analysis' | 'record'
export interface PreviewPosition { x: number; y: number }

export type DiagnosticOutcome = 'running' | 'awaiting_initial' | 'passed' | 'failed' | 'incomplete' | 'cancelled' | 'interrupted' | 'completed'
export interface DiagnosticConditions { lighting: 'normal' | 'dim' | 'side'; glasses: 'none' | 'worn'; distance: 'normal' | 'near' | 'far'; notes: string }
export interface DiagnosticTarget { index: number; target: [number, number]; valid_count: number; valid_span: number; complete: boolean; median_error: number | null; p90_error: number | null; coverage: number | null; durations: Record<string, number> }
export interface DiagnosticRecord {
  id: string; kind: 'calibration' | 'check' | 'trial'; status: DiagnosticOutcome; reason: string | null
  session_id: string | null; calibration_id: string | null; model_version: string; protocol_version: string; created_at: string
  display: DisplayGeometry | null; camera_config: number[] | null; conditions: DiagnosticConditions
  targets: DiagnosticTarget[]; durations: Record<string, number>; coverage: number | null
  validation?: GazeValidation; rejections?: Record<string, number>
  target_order?: [number, number][]; target_index?: number; completed_targets?: number; collecting?: boolean
  valid_count?: number; median_error?: number | null; p90_error?: number | null
  study_seconds?: number; buckets?: { index: number; durations: Record<string, number>; coverage: number | null }[]
  windows?: { check_id: string; start: number; end: number | null }[]
  checkpoints?: Record<string, { status: string; check_id: string | null; study_seconds?: number }>
  reminder?: string | null
}
export interface DiagnosticState { save_error?: string | null; check: DiagnosticRecord | null; trial: DiagnosticRecord | null; recent: DiagnosticRecord[]; calibration_ready: boolean; calibration_busy: boolean }

export interface Reflection { concentration: number | null; distraction: number | null; flow: 'yes' | 'no' | 'unsure' | null }
export type AnnotationKind = 'focused' | 'distracted' | 'flow'
export interface StudyAnnotation { start: number; end: number; kind: AnnotationKind }
export interface AnalysisAvailability { available: boolean; reasons: string[] }
export interface AnalysisSummary {
  version: string; availability: AnalysisAvailability
  sustained_count: number | null; sustained_seconds: number | null; longest_sustained: number | null
  interruption_count: number | null; interruption_seconds: number | null
  eligible_seconds: number | null; observed_seconds: number | null; observation_coverage: number | null
  tagged_seconds: Record<AnnotationKind, number>; self_reported_sustained_seconds: number
  reflection: Reflection
}
export interface SessionAnalysis {
  session_id: string; summary: AnalysisSummary; threshold_seconds: number
  intervals: { start: number; end: number; state: Presence | 'diagnostic' }[]
  sustained_periods: Interval[]; interruptions: Interval[]
  exclusions: { run_id: string; kind: 'calibration' | 'check'; start: number; end: number }[]
  reflection: Reflection; annotations: StudyAnnotation[]
}
