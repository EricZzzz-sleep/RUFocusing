import { useCallback, useEffect, useRef, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { api, auth, configured, type Settings as SettingsValue } from './api'
import { Link, navigate, usePath } from './Router'
import Auth from './Auth'
import { useStudySession } from './session'
import Record from './Record'
import Analysis from './Analysis'
import SessionDetails from './SessionDetails'
import Settings from './Settings'
import { registerStudyTools } from './webmcp'
export default function App() {
  const path = usePath(), [user, setUser] = useState<User | null>(null), [authLoaded, setAuthLoaded] = useState(!configured)
  const [authError, setAuthError] = useState(''), [recovery, setRecovery] = useState(location.pathname === '/auth/reset')
  const [settings, setSettings] = useState<SettingsValue | null>(null), [settingsError, setSettingsError] = useState(''), [retrySettings, setRetrySettings] = useState(0)
  const [dataVersion, setDataVersion] = useState(0), [signingOut, setSigningOut] = useState(false)
  const changed = useCallback(() => setDataVersion(value => value+1), [])
  const controller = useStudySession(user?.id)
  const ctrl = useRef(controller); ctrl.current = controller
  useEffect(() => {
    if (!auth) return
    let stopped = false
    const { data: { subscription } } = auth.auth.onAuthStateChange((event, session) => {
      if (stopped) return
      setUser(session?.user ?? null); setAuthLoaded(true)
      if (event === 'PASSWORD_RECOVERY') { setRecovery(true); navigate('/auth/reset', true) }
    })
    void auth.auth.getSession().then(({ data, error }) => {
      if (stopped) return
      if (error) setAuthError(error.message)
      setUser(data.session?.user ?? null); setAuthLoaded(true)
      const errorDescription = new URL(location.href).searchParams.get('error_description')
      if (errorDescription) setAuthError(errorDescription)
    })
    return () => { stopped = true; subscription.unsubscribe() }
  }, [])
  useEffect(() => {
    if (path !== '/auth/reset') setRecovery(false)
    if (user && path === '/auth/callback') navigate('/analysis', true)
    requestAnimationFrame(() => { const heading = Array.from(document.querySelectorAll<HTMLElement>('main h1')).find(node => !node.closest('[hidden]')); if (heading) { heading.tabIndex = -1; heading.focus() } })
  }, [path, user?.id, Boolean(settings)])
  useEffect(() => {
    let stale = false; setSettings(null); setSettingsError('')
    if (!user) return
    void (async () => {
      try {
        let value = await api<SettingsValue>('/settings')
        if (stale) return
        if (!value.timezone) value = await api<SettingsValue>('/settings', { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', default_mode: value.default_mode })
        if (!stale) setSettings(value)
      } catch (e) { if (!stale) setSettingsError(e instanceof Error ? e.message : 'Could not load preferences.') }
    })()
    return () => { stale = true }
  }, [user?.id, retrySettings])
  useEffect(() => {
    if (!user) return
    return registerStudyTools(() => ({ active: ctrl.current.active, connected: ctrl.current.connected }), (action, data) => ctrl.current.command(action, data), navigate)
  }, [user?.id])
  async function signOut() {
    if (!auth || signingOut) return; setSigningOut(true); setAuthError('')
    try {
      if (controller.retry) throw new Error('Retry the pending session save before signing out.')
      if (controller.active?.status === 'running' && controller.owned) await controller.command('pause')
      const result = await auth.auth.signOut(); if (result.error) throw result.error
      navigate('/', true)
    } catch (e) { setAuthError(e instanceof Error ? e.message : 'Could not sign out. Please retry.') }
    finally { setSigningOut(false) }
  }
  const publicPage = path === '/' && !user
  const detail = path.match(/^\/sessions\/([0-9a-f-]{36})$/i)
  const known = ['/', '/analysis', '/record', '/settings', '/auth/callback', '/auth/reset'].includes(path) || Boolean(detail)
  return <>
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>Skip to study workspace</a>
    <header className="app-header"><div className="header-inner"><Link href={user ? '/analysis' : '/'} className="brand"><span className="brand-mark" aria-hidden="true">r<span>u</span></span>RUFocusing<span className="brand-divider"/><span className="header-section">Study space</span></Link>{user ? <button className="text-button" disabled={signingOut || controller.busy} onClick={() => void signOut()}>{signingOut ? 'Signing out…' : 'Sign out'}</button> : <span className="connection">Your private study space</span>}</div></header>
    <main id="main-content" tabIndex={-1}>
      {authError && <p className="error" role="alert">{authError}</p>}
      {!authLoaded ? <p role="status">Checking sign-in…</p> : !known ? <><h1>Page not found.</h1><Link className="button primary" href={user ? '/analysis' : '/'}>Return to your study space</Link></> : !user ? <div className={publicPage ? 'welcome-grid' : 'sign-in-page'}>
        <div><p className="eyebrow">A LITTLE MORE INTENTION</p><h1 tabIndex={-1}>Make time for<br/>your work<span>.</span></h1><p className="intro">Record a session. See how it unfolds. Find a rhythm that works for you.</p><p>Optional camera tracking stays in your browser. Your saved sessions are private to your account.</p><ul className="welcome-points"><li>A simple timer with breaks when you need them.</li><li>Presence-based timelines with honest gaps.</li><li>Your history, reflections, and exports in one place.</li></ul></div><Auth/>
      </div> : recovery ? <div className="sign-in-page"><Auth recovery/></div> : <>
        <nav className="workspace-nav" aria-label="Study workspace">{[['/analysis','Analysis'],['/record','Record'],['/settings','Settings']].map(([href,label]) => <Link key={href} href={href} aria-current={path === href || (path === '/' && href === '/analysis') ? 'page' : undefined}>{label}</Link>)}</nav>
        {controller.error && <p className="error" role="alert">{controller.error}</p>}
        {!controller.connected && <p className="notice" role="status">Connection lost. Only the last acknowledged checkpoint is saved.</p>}
        {controller.retry && !controller.busy && <p className="notice">A save needs confirmation. <button className="button secondary" onClick={() => void controller.retrySave().catch(() => {})}>Retry pending save</button></p>}
        {controller.busy && <p className="save-status" role="status">Saving checkpoint or session change…</p>}
        {settingsError ? <p className="error" role="alert">{settingsError} <button className="text-button" onClick={() => setRetrySettings(value => value+1)}>Retry preferences</button></p> : !settings ? <p role="status">Loading your workspace…</p> : <>
          {controller.active && path !== '/record' && <div className="notice active-session-status">{controller.active.status === 'break' ? 'Session paused' : 'Session in progress'} · {controller.active.task} <Link href="/record">Return to session →</Link></div>}
          <div hidden={path !== '/record'}><Record key={`${user.id}:${settings.default_mode}`} controller={controller} settings={settings}/></div>
          {(path === '/analysis' || path === '/' || path === '/auth/callback') && <Analysis version={dataVersion+controller.version} timezone={settings.timezone!}/>}
          {detail && <SessionDetails key={detail[1]} id={detail[1]} timezone={settings.timezone!} changed={changed}/>}
          {path === '/settings' && <Settings user={user} settings={settings} active={Boolean(controller.active)} onSaved={value => { setSettings(value); changed() }}/>}
        </>}
      </>}
      <footer><span>RUFocusing <span aria-hidden="true">/</span> A little time, well understood.</span><span>{user ? 'Private to your account' : 'Optional camera · No video uploads'}</span></footer>
    </main>
  </>
}
