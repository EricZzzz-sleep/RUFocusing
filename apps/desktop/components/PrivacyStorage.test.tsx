import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { jsonRequest } from '../src/api'
import PrivacyStorage from './PrivacyStorage'
import type { StudySession } from '../src/types'

vi.mock('../src/api', () => ({ jsonRequest: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const storage = { bytes: 1048576, sessions: 1, gaze_setup_saved: true, can_delete: true }
const sessions = [{ id: 'saved', task: 'Private task', started_at: '2026-09-16T10:00:00Z' }] as StudySession[]
afterEach(() => vi.resetAllMocks())

describe('Privacy and storage', () => {
  it('shows automatic cleanup failures returned by storage status', async () => {
    const warning = 'Temporary camera observations were deleted, but disk space could not be reclaimed.'
    vi.mocked(jsonRequest).mockResolvedValue({ ...storage, warning })
    const host = document.createElement('div'); const root = createRoot(host)
    try {
      await act(async () => root.render(<PrivacyStorage sessions={sessions} active={false} onChange={vi.fn()} />))
      expect(host.querySelector('[role="status"]')?.textContent).toBe(warning)
    } finally { await act(async () => root.unmount()) }
  })
  it('requires confirmation and refreshes history only after deletion succeeds', async () => {
    vi.mocked(jsonRequest).mockResolvedValue(storage)
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host); const onChange = vi.fn().mockResolvedValue(undefined)
    try {
      await act(async () => root.render(<PrivacyStorage sessions={sessions} active={false} onChange={onChange} />))
      expect(host.textContent).toContain('1.00 MB')
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Delete Private task"]')!.click())
      expect(vi.mocked(jsonRequest)).toHaveBeenCalledTimes(1)
      const button = [...host.querySelectorAll('button')].find(item => item.textContent === 'Confirm deletion')!
      await act(async () => button.click())
      expect(jsonRequest).toHaveBeenLastCalledWith('/api/storage/delete-session', { session_id: 'saved' })
      expect(onChange).toHaveBeenCalledOnce()
    } finally { await act(async () => root.unmount()); host.remove() }
  })
  it('disables deletion during a session and keeps a failed deletion reviewable', async () => {
    vi.mocked(jsonRequest).mockResolvedValue(storage)
    const host = document.createElement('div'); const root = createRoot(host)
    const onChange = vi.fn().mockResolvedValue(undefined)
    try {
      await act(async () => root.render(<PrivacyStorage sessions={sessions} active onChange={onChange} />))
      expect([...host.querySelectorAll('button')].every(button => button.disabled)).toBe(true)
      await act(async () => root.render(<PrivacyStorage sessions={sessions} active={false} onChange={onChange} />))
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Delete Private task"]')!.click())
      vi.mocked(jsonRequest).mockRejectedValueOnce(new Error('Disk unavailable'))
      await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Confirm deletion')!.click())
      expect(host.querySelector('[role="alert"]')?.textContent).toBe('Disk unavailable')
      expect(host.querySelector('[role="alertdialog"]')).not.toBeNull()
      expect(onChange).not.toHaveBeenCalled()
    } finally { await act(async () => root.unmount()) }
  })
})
