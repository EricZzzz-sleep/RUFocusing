// Exercise the development-only diagnostics with synthetic API responses, no camera.
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root: desktop, server: { host: '127.0.0.1', port: 0, open: false } });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  let camera = false, check = null;
  const recent = [], actions = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const diagnostics = () => ({ check, trial: null, recent, calibration_ready: true, calibration_busy: false });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), endpoint = url.pathname;
    let result;
    if (endpoint === '/api/camera/preview') { await route.fulfill({ status: 204 }); return; }
    if (endpoint === '/api/camera/preview/start') camera = true;
    if (endpoint === '/api/camera/preview/stop') camera = false;
    if (endpoint === '/api/state' || endpoint.startsWith('/api/camera/')) {
      result = { active: null, state: 'unknown', history: [], preview_active: camera,
        observation: { camera_status: camera ? 'ready' : 'off', available: camera, face_count: camera ? 1 : null,
          pitch: null, yaw: null, roll: null, message: camera ? 'Synthetic camera ready.' : 'Camera off.' } };
    } else if (endpoint === '/api/gaze/state' || endpoint === '/api/gaze/calibration/display') {
      result = { experimental: true, quality: 'usable', diagnostic_check_active: Boolean(check),
        observation: { timestamp: 1, valid: camera, x: null, y: null, region: null, reason: 'estimated', calibration_id: 'synthetic' },
        calibration: { id: 'synthetic', status: 'ready', reason: 'estimated', display: null, validation: null,
          targets: [], completed_targets: 13, target_count: 13, collecting: false, target_error: null } };
    } else if (endpoint === '/api/gaze/diagnostics/state') result = diagnostics();
    else if (endpoint.startsWith('/api/gaze/checks/')) {
      const action = endpoint.split('/').at(-1); actions.push(action);
      if (action === 'start') check = { id: 'synthetic-check', kind: 'check', status: 'running', session_id: null,
        calibration_id: 'synthetic', created_at: new Date().toISOString(), targets: [], durations: {},
        target_order: [.2, .5, .8].flatMap(y => [.2, .5, .8].map(x => [x, y])), completed_targets: 0, collecting: false };
      if (action === 'target') {
        await expect(page.getByRole('img', { name: 'Accuracy target 1 of 9', exact: true })).toBeVisible();
        check.collecting = true;
      }
      if (action === 'cancel') { recent.push({ ...check, status: 'cancelled', reason: 'user_cancelled' }); check = null; }
      result = diagnostics();
    } else throw new Error(`Unexpected API request: ${endpoint}`);
    await route.fulfill({ json: result });
  });
  await page.goto(origin + '/#record');
  await expect(page.getByRole('button', { name: 'Start session', exact: true })).toBeVisible();
  await expect(page.locator('.diagnostics-panel')).toHaveCount(0);
  await page.goto(origin + '/?diagnostics=1#record');
  await expect(page.locator('.diagnostics-panel')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Use camera', exact: true }).check();
  await page.getByRole('button', { name: 'Close camera preview', exact: true }).click();
  // Closing a setup preview turns capture off. Open again for the synthetic check.
  await page.getByRole('button', { name: 'Show camera preview', exact: true }).click();
  await page.getByRole('button', { name: 'Check gaze accuracy', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Look at the accuracy target', exact: true })).toBeVisible();
  await expect.poll(() => actions.includes('target')).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('.accuracy-screen')).toHaveCount(0);
  await expect.poll(() => actions.includes('cancel')).toBe(true);
  await page.getByRole('button', { name: 'Close camera preview', exact: true }).click();
  await mkdir(path.join(desktop, 'build'), { recursive: true });
  await page.screenshot({ path: path.join(desktop, 'build/reliability-diagnostics.png'), fullPage: true });
  expect(errors).toEqual([]);
  console.log('Development diagnostics passed: opt-in visibility, painted target, cancellation, and local numerical results. No physical camera used.');
} finally {
  await browser?.close();
  await server.close();
}
