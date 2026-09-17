import { useEffect, useRef, useState } from 'react'
import { jsonRequest } from '../src/api'
import type { StudySession } from '../src/types'
import { dateLabel } from '../src/types'

type Storage = { bytes: number; sessions: number; gaze_setup_saved: boolean; can_delete: boolean; warning?: string | null }
type Choice = { action: 'delete-session' | 'clear-history' | 'reset-gaze'; title: string; id?: string }

export default function PrivacyStorage({ sessions, active, onChange }: { sessions: StudySession[]; active: boolean; onChange: () => Promise<void> }) {
  const [storage, setStorage] = useState<Storage | null>(null)
  const [choice, setChoice] = useState<Choice | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const cancelButton = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (choice) cancelButton.current?.focus() }, [choice])
  useEffect(() => {
    let cancelled = false
    void jsonRequest<Storage>('/api/storage').then(value => { if (!cancelled) setStorage(value) }).catch(() => { if (!cancelled) setError('Storage information could not be loaded. Reopen this page to retry.') })
    return () => { cancelled = true }
  }, [active, sessions.length])
  const disabled = busy || active || !storage || !storage.can_delete
  async function confirm() {
    if (!choice || disabled) return
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await jsonRequest<Storage>(`/api/storage/${choice.action}`, { session_id: choice.id })
      setStorage(result); setChoice(null)
      setMessage(result.warning || (choice.action === 'reset-gaze' ? 'Saved gaze setup was reset.' : 'History deleted. Available disk space has been reclaimed.'))
      await onChange()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Saved data could not be changed. Please retry.') }
    finally { setBusy(false) }
  }
  return <section className="panel privacy-panel" aria-label="Privacy and storage">
    <h2>Your data stays on this device</h2>
    <p>Camera images are processed on this device and are never saved or uploaded.</p>
    <p>Temporary camera observations are automatically deleted when a session ends. Your study timeline and reports stay saved. Cleanup also runs when you reopen the app after an interruption.</p>
    <p>RUFocusing keeps your reports, study history, reflections, and gaze setup in your local app-data folder. It has no cloud account, analytics uploads, or automatic update checks.</p>
    <p className="muted">Your device account protects access. There is no app password or app-level encryption. Device backups, administrators, and software with access to your account may access saved reports.</p>
    <dl className="storage-totals"><div><dt>Saved data</dt><dd>{storage ? `${(storage.bytes / 1024 / 1024).toFixed(2)} MB` : 'Loading…'}</dd></div><div><dt>Sessions</dt><dd>{storage?.sessions ?? '—'}</dd></div><div><dt>Gaze setup</dt><dd>{storage ? storage.gaze_setup_saved ? 'Saved' : 'Not saved' : '—'}</dd></div></dl>
    <p className="muted small">Storage shown includes the local database and its temporary journal files. The installed app and bundled analysis model are separate.</p>
    {active && <p className="notice">End your current session before deleting history or resetting gaze setup.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {message && <p className="notice" role="status">{message}</p>}
    {!message && storage?.warning && <p className="notice" role="status">{storage.warning}</p>}
    <div className="storage-actions"><button className="button secondary" disabled={disabled} onClick={() => setChoice({ action: 'clear-history', title: 'Delete all saved study history?' })}>Clear all history</button><button className="button secondary" disabled={disabled || !storage?.gaze_setup_saved} onClick={() => setChoice({ action: 'reset-gaze', title: 'Reset your saved gaze setup?' })}>Reset gaze setup</button></div>
    {choice && <div className="storage-confirm" role="alertdialog" aria-labelledby="storage-confirm-title" aria-describedby="storage-confirm-description">
      <h3 id="storage-confirm-title">{choice.title}</h3><p id="storage-confirm-description">{choice.action === 'reset-gaze' ? 'You will need to set up gaze again. Your saved study reports will remain.' : 'This cannot be undone. Related observations, reflections, and tags will also be deleted. Your saved gaze setup will remain.'}</p>
      <div className="storage-actions"><button ref={cancelButton} className="button secondary" disabled={busy} onClick={() => setChoice(null)}>Cancel</button><button className="button primary" disabled={disabled} onClick={() => void confirm()}>{busy ? 'Working…' : 'Confirm deletion'}</button></div>
    </div>}
    <h3>Saved sessions</h3>
    {!sessions.length && <p className="muted">No saved sessions.</p>}
    <ul className="storage-sessions">{sessions.map(item => <li key={item.id}><div><strong>{item.task}</strong><span className="muted small">{dateLabel(item.started_at)}</span></div><button className="text-button" disabled={disabled} aria-label={`Delete ${item.task}`} onClick={() => setChoice({ action: 'delete-session', title: `Delete “${item.task}”?`, id: item.id })}>Delete</button></li>)}</ul>
  </section>
}
