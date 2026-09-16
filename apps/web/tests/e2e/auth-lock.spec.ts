import { test, expect } from '@playwright/test'

test('auth locks preserve exclusion, timeouts, and failure recovery without page errors', async ({ page, context }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  const second = await context.newPage(); await second.goto('/')
  await second.evaluate(async () => {
    const ready = new Promise<void>(resolve => {
      void navigator.locks.request('beta-auth-test', async () => {
        await new Promise<void>(release => { Object.assign(window, { releaseTestLock: release }); resolve() })
      })
    })
    await ready
  })
  const failures = await page.evaluate(async path => {
    const { browserAuthLock } = await import(path)
    const results = []
    for (const timeout of [0, 25]) {
      try { await browserAuthLock('beta-auth-test', timeout, async () => 'must not enter'); results.push(false) }
      catch (error) { results.push(Boolean((error as { isAcquireTimeout?: boolean }).isAcquireTimeout)) }
    }
    return results
  }, '/src/auth-lock.ts')
  expect(failures).toEqual([true, true])
  await second.evaluate(() => (window as unknown as { releaseTestLock: () => void }).releaseTestLock())
  const result = await page.evaluate(async path => {
    const { browserAuthLock } = await import(path)
    let message = ''
    try { await browserAuthLock('beta-auth-test', -1, async () => { throw new Error('expected failure') }) }
    catch (error) { message = (error as Error).message }
    return [message, await browserAuthLock('beta-auth-test', -1, async () => 'recovered')]
  }, '/src/auth-lock.ts')
  expect(result).toEqual(['expected failure', 'recovered']); expect(errors).toEqual([])
})
