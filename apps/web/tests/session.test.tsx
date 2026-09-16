// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useStudySession, type SessionController } from '../src/session'
import { ApiError, type Command } from '../src/api'
const { api } = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../src/api', () => ({
  api, tabId: 'tab',
  ApiError: class extends Error { constructor(message: string, public status: number) { super(message) } },
  newCommand: (action: string, session: null, data: object) => ({ action, data, tab_id: 'tab', command_id: crypto.randomUUID() }),
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root, host: HTMLDivElement, controller: SessionController
function Harness() { controller = useStudySession('account'); return null }
beforeEach(() => {
  vi.useFakeTimers(); api.mockReset(); sessionStorage.clear()
  host = document.createElement('div'); root = createRoot(host)
  api.mockResolvedValue({ active: null, server_now: new Date().toISOString() })
})
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers() })
it('clears a failed state read when polling reconnects', async () => {
  api.mockRejectedValueOnce(new ApiError('Offline', 0))
  await act(async () => root.render(<Harness/>))
  expect(controller.connected).toBe(false); expect(controller.error).toBe('Offline')
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  expect(controller.connected).toBe(true); expect(controller.error).toBe('')
})
it('keeps an ambiguous command and its warning after reads recover, then retries the exact command', async () => {
  const commands: Command[] = []
  api.mockImplementation(async (path: string, command?: Command) => {
    if (path === '/state') return { active: null }
    commands.push(command!)
    if (commands.length === 1) throw new ApiError('Save response lost', 0)
    return { session: null, deleted: false, replayed: true }
  })
  await act(async () => root.render(<Harness/>))
  await act(async () => { await controller.command('start', { task: 'Study', mode: 'Math' }).catch(() => {}) })
  expect(controller.connected).toBe(true)
  expect(controller.error).toBe('Save response lost'); expect(controller.retry).toEqual(commands[0])
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  expect(controller.retry).toEqual(commands[0]); expect(controller.error).toBe('Save response lost')
  await act(async () => { await controller.retrySave() })
  expect(commands[1]).toEqual(commands[0]); expect(controller.retry).toBeNull(); expect(controller.error).toBe('')
  expect(sessionStorage.getItem('rufocusing:pending:account')).toBeNull()
})
it('preserves a rejected command message when its following state read succeeds', async () => {
  api.mockImplementation(async (path: string) => {
    if (path === '/state') return { active: null }
    throw new ApiError('Session changed. Reload and retry.', 409)
  })
  await act(async () => root.render(<Harness/>))
  await act(async () => { await controller.command('start').catch(() => {}) })
  expect(controller.retry).toBeNull(); expect(controller.error).toContain('Session changed')
})
it('retains the exact pending command across expired sign-in and recovery', async () => {
  let expired = false
  const commands: Command[] = []
  api.mockImplementation(async (path: string, command?: Command) => {
    if (path === '/commands') commands.push(command!)
    if (expired) throw new ApiError('Sign in again', 401)
    return path === '/state' ? { active: null } : { session: null, replayed: true }
  })
  await act(async () => root.render(<Harness/>))
  expired = true
  await act(async () => { await controller.command('start', { task: 'Recovery', mode: 'Math' }).catch(() => {}) })
  expect(controller.requiresSignIn).toBe(true); expect(controller.retry).toEqual(commands[0])
  expired = false
  await act(async () => { await controller.refresh() })
  expect(controller.requiresSignIn).toBe(false); expect(controller.retry).toEqual(commands[0])
  await act(async () => { await controller.retrySave() })
  expect(commands[1]).toEqual(commands[0]); expect(controller.retry).toBeNull(); expect(controller.error).toBe('')
})
