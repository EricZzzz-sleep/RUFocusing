import { app, BrowserWindow, dialog, Menu, powerMonitor, protocol, session, systemPreferences } from 'electron';
import { readFile, mkdir, realpath, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Backend } from './backend.mjs';
import { APP_ORIGIN, CSP, allowedAPI, assetPath, isAppURL } from './security.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(directory, '..');
const assets = path.join(desktopRoot, 'dist');
const defaultData = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'), 'RUFocusing')
  : path.join(app.getPath('appData'), 'RUFocusing');
// Explicit test isolation; normal launches always use the OS-local default.
const localData = process.env.RUFOCUSING_TEST_DATA_DIR ? path.resolve(process.env.RUFOCUSING_TEST_DATA_DIR) : defaultData;
app.setPath('userData', localData);
app.enableSandbox();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-sync');
protocol.registerSchemesAsPrivileged([{ scheme: 'rufocusing', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

let window, backend;
let quitting = false, recovering = false;
const singleton = app.requestSingleInstanceLock();
if (!singleton) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void (async () => { await backend?.stop(); app.quit(); })();
  });
  void app.whenReady().then(start).catch(() => {
    dialog.showErrorBox('RUFocusing could not start', 'Check that your local app-data folder is writable, then restart RUFocusing. Reinstall the app if the problem continues.');
    app.quit();
  });
}

async function launchBackend() {
  const executable = path.join(app.isPackaged ? process.resourcesPath : path.join(desktopRoot, 'build'), 'backend',
    process.platform === 'win32' ? 'rufocusing-service.exe' : 'rufocusing-service');
  backend = new Backend(executable, path.join(localData, 'sessions.sqlite3'), () => void recover());
  await backend.ready;
  const health = await backend.request('GET', '/api/health');
  if (health.status !== 200 || JSON.parse(health.body.toString()).api_version !== 5) throw new Error('Incompatible backend.');
}

async function recover() {
  if (quitting || recovering) return;
  recovering = true;
  await window.loadURL(`${APP_ORIGIN}/unavailable.html`);
  while (!quitting) {
    await backend?.stop();
    const { response } = await dialog.showMessageBox(window, { type: 'error', title: 'Local service unavailable',
      message: 'Your local study service stopped.',
      detail: 'The camera will be released. Your saved history remains on this device. Retry to recover the last saved checkpoint. If this continues, check available disk space and reinstall RUFocusing.',
      buttons: ['Retry', 'Quit'], defaultId: 0, cancelId: 1 });
    if (response === 1) { app.quit(); break; }
    try { await launchBackend(); await window.loadURL(APP_ORIGIN + '/'); break; } catch { /* Keep recovery actionable. */ }
  }
  recovering = false;
}

async function start() {
  await mkdir(localData, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(localData, 0o700);
  // An in-memory browser session prevents camera previews and API data entering disk caches.
  const localSession = session.fromPartition('rufocusing-local');
  localSession.setPermissionRequestHandler((contents, permission, callback) => callback(permission === 'fullscreen' && isAppURL(contents.getURL())));
  localSession.setPermissionCheckHandler((contents, permission) => permission === 'fullscreen' && Boolean(contents && isAppURL(contents.getURL())));
  localSession.on('will-download', event => event.preventDefault());
  localSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isAppURL(details.url) && !details.url.startsWith('blob:rufocusing://app/') }));
  await localSession.protocol.handle('rufocusing', async request => {
    const headers = { 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' };
    const failure = (status, error) => new Response(JSON.stringify({ error }), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
    if (!isAppURL(request.url)) return failure(403, 'This address is not allowed.');
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      if (!allowedAPI(request.method, url.pathname)) return failure(404, 'Not found.');
      try {
        const body = request.method === 'POST' ? await request.text() : '';
        if (Buffer.byteLength(body) > 4096) return failure(413, 'The request is too large.');
        if (request.method === 'POST') {
          const data = JSON.parse(body);
          let opensCamera = url.pathname === '/api/camera/preview/start'
            || (url.pathname === '/api/sessions/start' && data.camera) || (url.pathname === '/api/sessions/camera' && data.enabled);
          if (url.pathname === '/api/sessions/resume') {
            const state = await backend.request('GET', '/api/state');
            opensCamera = JSON.parse(state.body.toString()).active?.camera_enabled === true;
          }
          if (opensCamera && process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('camera') === 'not-determined') {
            await systemPreferences.askForMediaAccess('camera');
          }
        }
        if (request.signal.aborted) return failure(408, 'Request cancelled.');
        const result = await backend.request(request.method, url.pathname + url.search, body);
        return new Response(result.status === 204 ? null : new Uint8Array(result.body), { status: result.status,
          headers: { ...headers, 'Content-Type': result.type, 'Cross-Origin-Resource-Policy': 'same-origin' } });
      } catch { return failure(503, 'The local service is unavailable. Restart RUFocusing or retry after checking available disk space.'); }
    }
    if (request.method !== 'GET') return failure(405, 'Method not allowed.');
    if (url.pathname === '/unavailable.html') return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><title>RUFocusing</title><body><h1>RUFocusing</h1><p>Connecting to your local workspace…</p><p>Your reports stay on this device.</p></body></html>', { headers: { ...headers, 'Content-Type': 'text/html' } });
    const file = assetPath(assets, url.pathname);
    if (!file) return failure(404, 'Not found.');
    try {
      const actual = await realpath(file);
      if (!actual.startsWith((await realpath(assets)) + path.sep)) return failure(403, 'Not allowed.');
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }[path.extname(actual)];
      if (!type) return failure(404, 'Not found.');
      return new Response(new Uint8Array(await readFile(actual)), { headers: { ...headers, 'Content-Type': type } });
    } catch { return failure(404, 'Application files are missing. Reinstall RUFocusing.'); }
  });
  window = new BrowserWindow({ width: 1200, height: 850, minWidth: 760, minHeight: 560, title: 'RUFocusing',
    backgroundColor: '#f5f6f1', webPreferences: { session: localSession, sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, devTools: !app.isPackaged, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!isAppURL(url)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => { backend?.command('suspend'); void recover(); });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'RUFocusing', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [{ label: 'Privacy & storage', click: () => void window.loadURL(APP_ORIGIN + '/#privacy') }, { role: 'quit' }] },
    { role: 'editMenu' }, { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ]));
  powerMonitor.on('suspend', () => backend?.command('suspend'));
  powerMonitor.on('resume', () => backend?.command('suspend'));
  await window.loadURL(`${APP_ORIGIN}/unavailable.html`);
  try { await launchBackend(); await window.loadURL(APP_ORIGIN + '/'); } catch { await recover(); }
}
