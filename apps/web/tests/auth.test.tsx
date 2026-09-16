// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Auth from '../src/Auth'

const { methods, navigate } = vi.hoisted(() => ({ methods: {
  signInWithOAuth: vi.fn(), resend: vi.fn(), signInWithPassword: vi.fn(),
  signUp: vi.fn(), resetPasswordForEmail: vi.fn(), updateUser: vi.fn(),
}, navigate: vi.fn() }))
vi.mock('../src/api', () => ({ configured: true, auth: { auth: methods } }))
vi.mock('../src/Router', () => ({ navigate }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let host: HTMLDivElement, root: Root
const button = (text: string) => [...host.querySelectorAll('button')].find(node => node.textContent === text)!
beforeEach(() => {
  vi.resetAllMocks(); host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
async function render(recovery = false) { await act(async () => root.render(<Auth recovery={recovery}/>)) }
async function fill(selector: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(selector)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
it('recovers from both rejected and returned Google errors without duplicate requests', async () => {
  let reject!: (error: Error) => void
  methods.signInWithOAuth.mockImplementationOnce(() => new Promise((_, no) => { reject = no }))
  await render()
  await act(async () => { button('Continue with Google').click(); button('Continue with Google').click() })
  expect(methods.signInWithOAuth).toHaveBeenCalledTimes(1)
  expect(button('Create an account').disabled).toBe(true)
  await act(async () => reject(new Error('Provider unreachable')))
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Provider unreachable')
  expect(button('Continue with Google').disabled).toBe(false)
  methods.signInWithOAuth.mockResolvedValueOnce({ error: new Error('Provider disabled') })
  await act(async () => button('Continue with Google').click())
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Provider disabled')
  expect(button('Continue with Google').disabled).toBe(false)
})
it('allows retrying verification delivery and clears the old error on success', async () => {
  await render(); await act(async () => button('Create an account').click())
  await fill('input[type="email"]', 'study@example.test')
  methods.resend.mockRejectedValueOnce(new Error('Email service unavailable'))
  await act(async () => button('Resend verification email').click())
  expect(host.textContent).toContain('Email service unavailable')
  expect(button('Resend verification email').disabled).toBe(false)
  methods.resend.mockResolvedValueOnce({ error: null })
  await act(async () => button('Resend verification email').click())
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(host.textContent).toContain('Verification email requested.')
  expect(methods.resend).toHaveBeenLastCalledWith(expect.objectContaining({ email: 'study@example.test', type: 'signup' }))
})
it.each(['signin', 'signup', 'reset', 'recovery'] as const)('keeps the %s form usable after a rejected request', async mode => {
  await render(mode === 'recovery')
  if (mode === 'signup') await act(async () => button('Create an account').click())
  if (mode === 'reset') await act(async () => button('Forgot password?').click())
  if (mode !== 'recovery') await fill('input[type="email"]', 'study@example.test')
  if (mode !== 'reset') await fill('input[type="password"]', 'Long-password-42!')
  const method = { signin: methods.signInWithPassword, signup: methods.signUp, reset: methods.resetPasswordForEmail, recovery: methods.updateUser }[mode]
  method.mockRejectedValueOnce(new Error('Request failed'))
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  expect(method).toHaveBeenCalledTimes(1)
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Request failed')
  expect(host.querySelector('fieldset')!.disabled).toBe(false)
  expect(navigate).not.toHaveBeenCalled()
})
