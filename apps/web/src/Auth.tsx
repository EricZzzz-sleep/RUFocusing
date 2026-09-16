import { useRef, useState } from 'react'
import { auth, configured } from './api'
import { navigate } from './Router'
export default function Auth({ recovery = false, initialEmail = '' }: { recovery?: boolean; initialEmail?: string }) {
  const [mode, setMode] = useState<'signin' | 'signup' | 'reset'>('signin')
  const [email, setEmail] = useState(initialEmail), [password, setPassword] = useState('')
  const [pending, setPending] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('')
  const locked = useRef(false)
  async function perform(action: () => Promise<void>) {
    if (!auth || locked.current) return
    locked.current = true; setPending(true); setError(''); setMessage('')
    try { await action() }
    catch (e) { setError(e instanceof Error ? e.message : 'Sign-in failed. Please retry.') }
    finally { locked.current = false; setPending(false) }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!auth) return
    const client = auth
    await perform(async () => {
      if (recovery) {
        const result = await client.auth.updateUser({ password }); if (result.error) throw result.error
        setPassword(''); navigate('/analysis', true)
      } else if (mode === 'signin') {
        const result = await client.auth.signInWithPassword({ email, password }); if (result.error) throw result.error
        navigate('/analysis', true)
      } else if (mode === 'signup') {
        const result = await client.auth.signUp({ email, password, options: { emailRedirectTo: `${location.origin}/auth/callback` } }); if (result.error) throw result.error
        setPassword(''); setMessage('Check your email to verify your account, then sign in.'); if (result.data.session) navigate('/analysis', true)
      } else {
        const result = await client.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/auth/reset` }); if (result.error) throw result.error
        setMessage('If this email has an account, you’ll receive a password reset link.')
      }
    })
  }
  async function google() {
    await perform(async () => {
      const result = await auth!.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${location.origin}/auth/callback` } })
      if (result.error) throw result.error
    })
  }
  async function resend() {
    await perform(async () => {
      const result = await auth!.auth.resend({ type: 'signup', email, options: { emailRedirectTo: `${location.origin}/auth/callback` } })
      if (result.error) throw result.error
      setMessage('Verification email requested. Check your inbox.')
    })
  }
  return <section className="panel auth-panel" aria-labelledby="auth-title"><h2 id="auth-title">{recovery ? 'Choose a new password' : mode === 'signup' ? 'Create your study space' : mode === 'reset' ? 'Reset your password' : 'Welcome to your study space'}</h2>
    {!configured && <p className="notice" role="status">Cloud accounts are not available yet. You can continue using the local app while the website is being set up.</p>}
    {!recovery && mode !== 'reset' && <><button className="button secondary google-button" disabled={pending || !configured} onClick={() => void google()}>Continue with Google</button><p className="auth-divider">or use your email</p></>}
    <form onSubmit={event => void submit(event)}><fieldset disabled={pending || !configured}>
      {!recovery && <label>Email<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)}/></label>}
      {(mode !== 'reset' || recovery) && <label>{recovery ? 'New password' : 'Password'}<input type="password" required minLength={recovery || mode === 'signup' ? 10 : undefined} autoComplete={recovery || mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)}/></label>}
      {(recovery || mode === 'signup') && <p className="muted small">Use at least 10 characters.</p>}
      <button className="button primary" type="submit">{pending ? 'Please wait…' : recovery ? 'Save new password' : mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Sign in'}</button>
    </fieldset></form>
    {!recovery && <div className="auth-actions"><button className="text-button" disabled={pending} onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(''); setMessage('') }}>{mode === 'signin' ? 'Create an account' : 'Back to sign in'}</button>{mode === 'signin' && <button className="text-button" disabled={pending} onClick={() => { setMode('reset'); setError(''); setMessage('') }}>Forgot password?</button>}{mode === 'signup' && <button className="text-button" disabled={pending || !configured || !email} onClick={() => void resend()}>Resend verification email</button>}</div>}
    {error && <p role="alert" className="error">{error}</p>}{message && <p role="status" className="notice">{message}</p>}
  </section>
}
