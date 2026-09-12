import { useEffect, useState } from 'react'
import { sessionDiagnostics } from '../src/diagnostics-api'
import type { DiagnosticRecord } from '../src/types'
import DiagnosticResults from './DiagnosticResults'
export default function SessionDiagnostics({ sessionId }: { sessionId: string }) {
  const [records, setRecords] = useState<DiagnosticRecord[] | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let stopped = false
    setError('')
    sessionDiagnostics(sessionId).then(data => { if (!stopped) setRecords(data) }).catch(() => { if (!stopped) setError('Could not load session diagnostics.') })
    return () => { stopped = true }
  }, [sessionId, attempt])
  return <section className="session-diagnostics"><h3>Gaze reliability diagnostics</h3>{error ? <p role="alert">{error} <button type="button" className="text-button" onClick={() => setAttempt(attempt + 1)}>Retry diagnostics</button></p> : records ? <DiagnosticResults records={records} /> : <p role="status">Loading diagnostics…</p>}</section>
}
