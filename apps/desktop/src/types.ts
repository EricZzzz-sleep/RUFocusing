export type Presence = 'present' | 'away' | 'break' | 'unknown'
export interface Interval { start: number; end: number; state: Presence }
export interface StudySession {
  id: string; task: string; mode: string; started_at: string; ended_at: string | null
  status: 'running' | 'break' | 'completed' | 'interrupted'
  camera_enabled: boolean; elapsed: number; timeline: Interval[]
  totals: Record<Presence, number>; longest_present: number
}
export interface AppState {
  active: StudySession | null; state: Presence; history: StudySession[]
  observation: { available: boolean; face_count: number | null; pitch: number | null; yaw: number | null; roll: number | null; message: string }
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
