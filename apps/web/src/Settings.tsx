import { useEffect, useRef, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { csvExport, modes, withReport, type CloudSession } from '../../../packages/study'
import { api, auth, preference, savePreference, type Settings as SettingsValue, type State } from './api'
import { navigate } from './Router'
function download(content: string, name: string, type: string) {
  const href = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a'); link.href = href; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(href), 1000)
}
export default function Settings({ user, settings, active, onSaved }: { user: User; settings: SettingsValue; active: boolean; onSaved: (value: SettingsValue) => void }) {
  const [timezone, setTimezone] = useState(settings.timezone ?? 'UTC'), [mode, setMode] = useState(settings.default_mode)
  const [camera, setCamera] = useState(() => preference('camera-default') === 'true')
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [pending, setPending] = useState('')
  const [confirm, setConfirm] = useState(false), [confirmation, setConfirmation] = useState('')
  const dialog = useRef<HTMLDialogElement>(null), locked = useRef(false)
  const zones = Array.from(new Set(['UTC', settings.timezone ?? 'UTC', ...Intl.supportedValuesOf('timeZone')])).sort()
  useEffect(() => { if (confirm) dialog.current?.showModal(); else dialog.current?.close() }, [confirm])
  async function perform(name: string, action: () => Promise<void>) {
    if (locked.current) return; locked.current = true; setPending(name); setError(''); setMessage('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : 'The action failed. Please retry.') }
    finally { locked.current = false; setPending('') }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); await perform('settings', async () => {
      const value = await api<SettingsValue>('/settings', { timezone, default_mode: mode }); onSaved(value); savePreference('camera-default', String(camera)); setMessage('Preferences saved.')
    })
  }
  async function exportData(format: 'json' | 'csv') {
    await perform('export', async () => {
      const snapshot = await api<State>('/state'), all: CloudSession[] = []; let after = ''
      do {
        const query = new URLSearchParams({ before: snapshot.server_now, after })
        const page = await api<CloudSession[]>(`/export?${query}`); all.push(...page)
        setMessage(`Preparing ${all.length} sessions…`)
        if (page.length < 100) break
        const next = page.at(-1)!.id; if (next === after) throw new Error('Export did not advance. Retry.'); after = next
      } while (true)
      if (format === 'json') download(JSON.stringify({ format: 'rufocusing-export', version: 1, exported_at: snapshot.server_now, settings, sessions: all }, null, 2), 'rufocusing-sessions.json', 'application/json')
      else download(csvExport(all.map(withReport)), 'rufocusing-sessions.csv', 'text/csv;charset=utf-8')
      setMessage(`Exported ${all.length} sessions. Keep this file private; it contains your study history.`)
    })
  }
  async function removeAccount() {
    await perform('delete', async () => { await api('/account/delete', { confirm: confirmation }); await auth!.auth.signOut({ scope: 'local' }); navigate('/', true) })
  }
  return <><div className="page-heading"><div><p className="eyebrow">YOUR SPACE, YOUR CHOICES</p><h1>Settings<span>.</span></h1><p className="intro">Manage your preferences and your study data.</p></div></div>
    {error && <p className="error" role="alert">{error}</p>}{message && <p className="notice" role="status">{message}</p>}
    <section className="panel"><h2>Your account</h2><p>{user.email}</p><p className="muted">Your sessions are private to this account and available across your devices.</p></section>
    <section className="panel"><h2>Study preferences</h2><form onSubmit={event => void save(event)}><fieldset disabled={Boolean(pending)}><label>Timezone<select value={timezone} onChange={event => setTimezone(event.target.value)}>{zones.map(zone => <option key={zone}>{zone}</option>)}</select></label><p className="muted">Analysis groups sessions by their start date in this timezone.</p><label>Default study mode<select value={mode} onChange={event => setMode(event.target.value)}>{modes.map(value => <option key={value}>{value}</option>)}</select></label><label className="checkbox-label"><input type="checkbox" checked={camera} onChange={event => setCamera(event.target.checked)}/>Select camera tracking by default on this device</label><p className="muted">Camera preference stays on this device. Browser permission is still required.</p><button className="button primary">{pending === 'settings' ? 'Saving…' : 'Save preferences'}</button></fieldset></form></section>
    <section className="panel"><h2>Export your data</h2><p>Download CSV summaries or a complete JSON copy of sessions, intervals, reflections, and personal tags.</p><div className="session-controls"><button className="button secondary" disabled={Boolean(pending)} onClick={() => void exportData('csv')}>Download CSV</button><button className="button secondary" disabled={Boolean(pending)} onClick={() => void exportData('json')}>Download JSON</button></div></section>
    <section className="panel"><h2>How your data is handled</h2><p>Your account, session timing, presence intervals, and optional reflections are stored in the cloud. Camera frames and face landmarks are processed only in browser memory.</p><p>Deep study, Normal, and Distracted are presence-based estimates, not measurements of mental concentration. Camera failures and missing evidence remain unknown. Personal reflections never change the automatic estimates.</p><p>There is no offline recording guarantee. If the recording tab loses contact for 30 seconds, your session pauses at the last saved checkpoint. Browser suspension can also interrupt tracking.</p><p>Existing local-app data stays on your device and is not imported automatically.</p></section>
    <section className="panel danger-zone"><h2>Delete your account</h2><p>This permanently removes your account, sessions, reflections, and settings from the application. Copies you exported and the separate local app are unaffected.</p>{active && <p className="notice">End your active session before deleting your account.</p>}<button className="button secondary danger" disabled={active || Boolean(pending)} onClick={() => setConfirm(true)}>Delete account</button></section>
    <dialog ref={dialog} className="confirm-dialog" aria-labelledby="delete-account-title" onCancel={() => { if (!pending) setConfirm(false) }}><h2 id="delete-account-title">Delete your account permanently?</h2><p>All saved cloud study data will be removed. This cannot be undone.</p><label>Type DELETE to confirm<input value={confirmation} disabled={Boolean(pending)} onChange={event => setConfirmation(event.target.value)} autoComplete="off"/></label><div className="session-controls"><button autoFocus className="button secondary" disabled={Boolean(pending)} onClick={() => setConfirm(false)}>Keep account</button><button className="button primary danger" disabled={confirmation !== 'DELETE' || Boolean(pending)} onClick={() => void removeAccount()}>{pending === 'delete' ? 'Deleting…' : 'Delete permanently'}</button></div>{error && <p role="alert">{error}</p>}</dialog>
  </>
}
