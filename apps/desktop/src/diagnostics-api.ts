import { jsonRequest } from './api'
import type { DiagnosticRecord, DiagnosticState } from './types'
export const diagnosticsState = (owner: string | null = null) => jsonRequest<DiagnosticState>(`/api/gaze/diagnostics/state${owner ? `?check_id=${encodeURIComponent(owner)}` : ''}`)
export const diagnosticCommand = (group: 'checks' | 'trials', action: string, body: object) => jsonRequest<DiagnosticState>(`/api/gaze/${group}/${action}`, body)
export const diagnosticDetail = (id: string) => jsonRequest<DiagnosticRecord>(`/api/gaze/diagnostics/${encodeURIComponent(id)}`)
export const sessionDiagnostics = (id: string) => jsonRequest<DiagnosticRecord[]>(`/api/gaze/diagnostics?session_id=${encodeURIComponent(id)}`)
