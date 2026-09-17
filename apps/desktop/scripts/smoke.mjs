import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rufocusing-smoke-'));
const executable = process.env.RUFOCUSING_TEST_EXECUTABLE;
const env = { ...process.env, RUFOCUSING_TEST_DATA_DIR: temporary };
delete env.ELECTRON_RUN_AS_NODE;
let application;
const networkLog = path.join(temporary, 'network.json');
const flags = [`--log-net-log=${networkLog}`];
const options = { ...(executable ? { executablePath: executable, args: flags } : { args: [...flags, desktop] }), env, timeout: 45000 };
try {
  application = await electron.launch(options);
  application.process().stderr.on('data', data => process.stderr.write(data));
  application.process().on('exit', (code, signal) => console.log('Electron exit:', code, signal));
  let page = await application.firstWindow();
  await page.getByRole('link', { name: 'Record', exact: true }).waitFor({ timeout: 45000 });
  await page.goto('rufocusing://app/?diagnostics=1#record');
  await page.getByRole('link', { name: 'Record', exact: true }).waitFor();
  assert.equal(await page.locator('.diagnostics-panel').count(), 0, 'Development diagnostics must not be exposed in production.');
  const preferences = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const unauthorized = await page.evaluate(async () => {
    try { await fetch('https://example.com'); return false; } catch { return true; }
  });
  assert.equal(unauthorized, true);
  const arbitrary = await page.evaluate(async () => (await fetch('/api/not-allowed')).status);
  assert.equal(arbitrary, 404);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.session.enableNetworkEmulation({ offline: true }));
  await page.reload();
  await page.getByRole('link', { name: 'Record', exact: true }).waitFor();
  const screenshot = path.join(desktop, 'build/desktop-smoke.png');
  await page.getByRole('link', { name: 'Record', exact: true }).click();
  await page.getByLabel('What are you working on?').fill('Offline packaged study');
  await page.getByRole('button', { name: 'Start session' }).click();
  await page.getByRole('button', { name: 'End & save session' }).waitFor();
  await application.evaluate(({ powerMonitor }) => { powerMonitor.emit('suspend'); });
  await page.getByRole('button', { name: 'Resume session' }).waitFor();
  await page.getByRole('button', { name: 'Resume session' }).click();
  await page.getByRole('button', { name: 'End & save session' }).click();
  await page.getByRole('button', { name: 'Close session details' }).click();
  await page.getByRole('link', { name: 'Privacy & storage' }).click();
  await page.getByRole('button', { name: 'Delete Offline packaged study' }).waitFor();
  await page.screenshot({ path: screenshot, fullPage: true });
  // Quit through the app lifecycle, not a forced test-runner process termination.
  const closed = application.waitForEvent('close');
  await application.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
  await closed;
  const network = JSON.parse(await fs.readFile(networkLog, 'utf8'));
  const remoteRequests = network.events.filter(event => {
    const value = event.params?.url;
    if (typeof value !== 'string' || !/^https?:/.test(value)) return false;
    return !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname);
  });
  assert.deepEqual(remoteRequests, [], 'Chromium must not issue external network requests.');
  application = await electron.launch(options);
  page = await application.firstWindow();
  await page.getByRole('link', { name: 'Privacy & storage' }).waitFor({ timeout: 45000 });
  await page.getByRole('link', { name: 'Privacy & storage' }).click();
  await page.getByRole('button', { name: 'Delete Offline packaged study' }).click();
  await page.getByRole('button', { name: 'Confirm deletion' }).click();
  await page.getByText('No saved sessions.', { exact: true }).waitFor();
  const entries = await fs.readdir(temporary, { recursive: true });
  assert.equal(entries.some(file => /\.(mp4|webm|avi|mov|jpg|jpeg|png)$/i.test(file)), false);
  const done = application.waitForEvent('close');
  await application.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); });
  await done;
  application = null;
  console.log('Desktop smoke passed: isolated renderer, offline use, no Chromium external requests, session, sleep, restart, deletion, and no saved camera media.');
  console.log('Screenshot: ' + screenshot);
} finally {
  if (application) await application.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
