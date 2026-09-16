import { afterAll, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const directory = mkdtempSync(join(tmpdir(), 'rufocusing-release-'))
const script = fileURLToPath(new URL('../scripts/check-release.mjs', import.meta.url))
const publicKey = 'sb_publishable_test_only'
const jwt = (role: string) => `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.test-signature`
afterAll(() => rmSync(directory, { recursive: true, force: true }))
function check(url = '', key = '') {
  return spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8', env: { ...process.env, VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: key } })
}
it.each(['http://127.0.0.1:54321', 'https://localhost', 'https://127.0.0.2', 'https://[::1]', 'https://dev.localhost'])('rejects local release backend %s', url => {
  const result = check(url, publicKey); expect(result.status).not.toBe(0); expect(result.stderr).toContain('never the local test backend')
})
it.each(['', 'sb_secret_do_not_publish', jwt('service_role'), 'not-a-key', 'eyJmalformed'])('rejects absent, malformed, or privileged browser keys (%#)', key => {
  expect(check('https://beta.supabase.co', key).status).not.toBe(0)
})
it('rejects missing or credential-bearing project URLs', () => {
  expect(check('', publicKey).status).not.toBe(0)
  expect(check('https://user:password@beta.supabase.co', publicKey).status).not.toBe(0)
  expect(check('https://beta.supabase.co/functions/v1', publicKey).status).not.toBe(0)
})
it.each([publicKey, jwt('anon')])('accepts only structurally public configuration (%#)', key => {
  expect(check('https://beta.supabase.co', key).status).toBe(0)
})
