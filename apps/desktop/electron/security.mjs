import path from 'node:path';

export const APP_ORIGIN = 'rufocusing://app';
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

const getRoutes = [
  /^\/api\/(health|state|storage|camera\/preview)$/,
  /^\/api\/gaze\/(state|diagnostics(?:\/[a-zA-Z0-9-]+)?)$/,
  /^\/api\/sessions\/[a-zA-Z0-9-]+\/(gaze|analysis)$/,
];
const postRoutes = [
  /^\/api\/sessions\/(start|pause|resume|end|camera)$/,
  /^\/api\/sessions\/[a-zA-Z0-9-]+\/(reflection|annotations)$/,
  /^\/api\/camera\/preview\/(start|stop)$/,
  /^\/api\/gaze\/calibration\/(start|target|complete|reset|display)$/,
  /^\/api\/gaze\/checks\/(start|target|complete|cancel)$/,
  /^\/api\/gaze\/trials\/(start|stop|reminder)$/,
  /^\/api\/storage\/(delete-session|clear-history|reset-gaze)$/,
];

export function isAppURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'rufocusing:' && url.hostname === 'app' && !url.port && !url.username && !url.password;
  } catch { return false; }
}

export function allowedAPI(method, pathname) {
  return (method === 'GET' ? getRoutes : method === 'POST' ? postRoutes : []).some(route => route.test(pathname));
}

export function assetPath(root, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').includes('..')) return null;
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const resolved = path.resolve(root, relative);
  return resolved.startsWith(path.resolve(root) + path.sep) ? resolved : null;
}
