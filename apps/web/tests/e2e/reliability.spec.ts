import { test, expect, type Page, type Download } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

const config = JSON.parse(execFileSync('npx', ['--yes', 'supabase@2.117.0', 'status', '-o', 'json'], {
  cwd: new URL('../../../../', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}))
if (config.API_URL !== 'http://127.0.0.1:54321') throw new Error('Browser tests require disposable local Supabase.')
const admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
let id = '', email = ''; const password = 'Beta-test-only-39!'
test.beforeEach(async () => {
  email = `beta-${crypto.randomUUID()}@example.test`
  const result = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (result.error) throw result.error
  id = result.data.user.id
})
test.afterEach(async () => { if (id) await admin.auth.admin.deleteUser(id) })
async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your study overview.' })).toBeVisible()
}
async function contents(download: Download) {
  const stream = await download.createReadStream(); let result = ''
  for await (const chunk of stream!) result += chunk.toString()
  return result
}

test('state polling recovers from an outage and removes the stale error', async ({ page }) => {
  await signIn(page)
  let offline = true
  await page.route('**/functions/v1/api/state', route => offline ? route.abort('failed') : route.continue())
  await expect(page.getByRole('alert').filter({ hasText: 'Connection lost' })).toBeVisible({ timeout: 10000 })
  offline = false
  await expect(page.getByRole('alert').filter({ hasText: 'Connection lost' })).toHaveCount(0, { timeout: 10000 })
  await page.getByRole('link', { name: 'Record', exact: true }).click()
  await page.getByLabel('What are you working on?').fill('Recovered connection')
  await expect(page.getByRole('button', { name: 'Start session' })).toBeEnabled()
})

test('expired authentication can be renewed before retrying the same save', async ({ page }) => {
  await signIn(page)
  await page.getByRole('link', { name: 'Record', exact: true }).click()
  await page.getByLabel('What are you working on?').fill('Renew sign-in')
  await page.getByRole('button', { name: 'Start session' }).click()
  await expect(page.getByRole('button', { name: 'End & save session' })).toBeEnabled()
  let expired = true; const commandIds: string[] = []
  await page.route('**/functions/v1/api/**', async route => {
    const body = route.request().postDataJSON()
    if (body?.action === 'end') commandIds.push(body.command_id)
    if (expired) await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Your sign-in expired. Sign in again.' }) })
    else await route.continue()
  })
  await page.getByRole('button', { name: 'End & save session' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in again to continue' })).toBeVisible()
  await page.route('**/auth/v1/token*', async route => {
    const response = await route.fetch()
    if (response.ok()) expired = false
    await route.fulfill({ response })
  })
  const recovery = page.getByRole('region', { name: 'Sign-in recovery' })
  await recovery.getByLabel('Password', { exact: true }).fill(password)
  await recovery.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(recovery).toHaveCount(0, { timeout: 10000 })
  await page.getByRole('button', { name: 'Retry pending save' }).click()
  await expect(page.getByRole('button', { name: 'Retry pending save' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /Renew sign-in/ })).toHaveCount(1)
  expect(commandIds).toHaveLength(2); expect(commandIds[1]).toBe(commandIds[0])
})

test('filters and exports include every page, with usable enlarged text', async ({ page }, testInfo) => {
  const now = Date.now()
  const sessions = Array.from({ length: 205 }, (_, index) => ({
    id: crypto.randomUUID(), user_id: id, task: `History item ${String(index).padStart(3, '0')}`,
    mode: index % 2 ? 'Reading' : 'Math', status: index === 204 ? 'interrupted' : 'completed',
    started_at: new Date(now - (index + 1) * 120000).toISOString(), ended_at: new Date(now - index * 120000 - 60000).toISOString(), elapsed: 60,
  }))
  const inserted = await admin.from('ru_sessions').insert(sessions); if (inserted.error) throw inserted.error
  const intervals = await admin.from('ru_intervals').insert(sessions.map(session => ({ session_id: session.id, user_id: id, start: 0, end: 60, state: 'unknown' })))
  if (intervals.error) throw intervals.error
  const reflection = await admin.from('ru_reflections').insert({ session_id: sessions[0].id, user_id: id, concentration: 4, flow: 'yes' })
  if (reflection.error) throw reflection.error
  const annotation = await admin.from('ru_annotations').insert({ session_id: sessions[0].id, user_id: id, start: 0, end: 30, kind: 'focused' })
  if (annotation.error) throw annotation.error
  await signIn(page)
  await expect(page.getByText('1–20 of 205', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByText('21–40 of 205', { exact: true })).toBeVisible()
  await page.getByLabel('Search tasks').fill('History item 004')
  await expect(page.getByText('1–1 of 1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Clear history filters' }).click()
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('interrupted')
  await expect(page.getByRole('link', { name: /History item 204/ })).toBeVisible()
  await page.getByRole('button', { name: 'Clear history filters' }).click()
  await page.locator('.history-filters').getByRole('combobox', { name: 'Study mode' }).selectOption('Reading')
  await expect(page.getByText('1–20 of 102', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Clear history filters' }).click()
  await expect(page.getByText('1–20 of 205', { exact: true })).toBeVisible()
  await page.addStyleTag({ content: 'html { font-size: 200%; }' })
  await page.screenshot({ path: `test-results/${testInfo.project.name}-enlarged-analysis.png`, fullPage: true })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByRole('combobox', { name: 'Timezone', exact: true }).selectOption('America/Toronto')
  await page.getByRole('combobox', { name: 'Default study mode' }).selectOption('Reading')
  await page.getByRole('button', { name: 'Save preferences' }).click()
  await expect(page.getByText('Preferences saved.', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Default study mode' })).toHaveValue('Reading')
  await expect(page.getByRole('combobox', { name: 'Timezone', exact: true })).toHaveValue('America/Toronto')
  const jsonDownload = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download JSON' }).click()
  const json = JSON.parse(await contents(await jsonDownload))
  expect(json.sessions).toHaveLength(205)
  expect(new Set(json.sessions.map((session: { id: string }) => session.id))).toEqual(new Set(sessions.map(session => session.id)))
  const first = json.sessions.find((session: { id: string }) => session.id === sessions[0].id)
  expect(first.reflection.concentration).toBe(4); expect(first.annotations).toHaveLength(1); expect(first.timeline).toHaveLength(1)
  const csvDownload = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download CSV' }).click()
  const csv = await contents(await csvDownload)
  expect(csv.trim().split('\r\n')).toHaveLength(206)
  for (const session of sessions) expect(csv).toContain(session.id)
})

test('a missing saved camera can be reset without accessing a real webcam', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('rufocusing:camera-device', 'disconnected-camera')
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: (constraints: MediaStreamConstraints) => {
      const video = constraints.video as MediaTrackConstraints
      return Promise.reject(new DOMException('Test camera', video.deviceId ? 'OverconstrainedError' : 'NotAllowedError'))
    } })
  })
  await signIn(page)
  await page.getByRole('link', { name: 'Record', exact: true }).click()
  await page.getByLabel('What are you working on?').fill('Missing camera')
  await page.getByRole('checkbox', { name: 'Use camera for presence estimates' }).check()
  await page.getByRole('button', { name: 'Start session' }).click()
  await expect(page.getByText(/Camera not found/).first()).toBeVisible()
  await page.getByRole('button', { name: 'Use default camera', exact: true }).click()
  await expect(page.getByText(/Camera permission was denied/).first()).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('rufocusing:camera-device'))).toBe('')
  await page.getByRole('button', { name: 'End & save session' }).click()
  await expect(page.getByRole('heading', { name: 'Session summary.' })).toBeVisible()
})

test('personal timeline tags can be added, edited, cleared, and reloaded without changing timing', async ({ page }) => {
  const sessionId = crypto.randomUUID(), ended = new Date().toISOString()
  const inserted = await admin.from('ru_sessions').insert({ id: sessionId, user_id: id, task: 'Timeline tags', mode: 'Math', status: 'completed', elapsed: 60, started_at: new Date(Date.now() - 60000).toISOString(), ended_at: ended })
  if (inserted.error) throw inserted.error
  const interval = await admin.from('ru_intervals').insert({ session_id: sessionId, user_id: id, start: 0, end: 60, state: 'unknown' })
  if (interval.error) throw interval.error
  await signIn(page); await page.getByRole('link', { name: /Timeline tags/ }).click()
  await page.getByLabel('End time', { exact: true }).fill('00:00:30')
  await page.getByRole('button', { name: 'Add tag to list' }).click()
  await page.getByRole('button', { name: 'Save timeline tags', exact: true }).click()
  await expect(page.getByText('Timeline tags saved.', { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Edit Focused tag starting 00:00:00' }).click()
  await page.getByRole('combobox', { name: 'Tag', exact: true }).selectOption('flow')
  await page.getByRole('button', { name: 'Update tag in list' }).click()
  await page.getByRole('button', { name: 'Save timeline tags', exact: true }).click()
  await expect(page.getByText('Timeline tags saved.', { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Delete Flow tag starting 00:00:00' }).click()
  await page.getByRole('button', { name: 'Save timeline tags', exact: true }).click()
  await expect(page.getByText('Timeline tags saved.', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText('No personal timeline tags.', { exact: true })).toBeVisible()
  await expect(page.getByText('No tracking data', { exact: true })).toBeVisible()
  const saved = await admin.from('ru_intervals').select('start,end,state').eq('session_id', sessionId)
  expect(saved.data).toEqual([{ start: 0, end: 60, state: 'unknown' }])
})
