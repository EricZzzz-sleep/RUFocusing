import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { allowedAPI, assetPath, isAppURL, CSP } from './security.mjs';

test('only the private application origin is accepted', () => {
  assert.ok(isAppURL('rufocusing://app/assets/main.js'));
  for (const url of ['https://app/', 'file:///tmp/index.html', 'rufocusing://app.evil/', 'rufocusing://user@app/', 'rufocusing://app:8080/']) assert.equal(isAppURL(url), false);
});
test('API forwarding is restricted by both route and method', () => {
  assert.ok(allowedAPI('GET', '/api/storage'));
  assert.ok(allowedAPI('POST', '/api/storage/delete-session'));
  assert.ok(allowedAPI('POST', '/api/sessions/a-123/reflection'));
  for (const [method, route] of [['POST', '/api/health'], ['GET', '/api/storage/clear-history'], ['POST', '/api/shutdown'], ['PUT', '/api/state'], ['GET', '/api/sessions/../../file']]) assert.equal(allowedAPI(method, route), false);
});
test('asset paths cannot escape the bundled frontend', () => {
  const root = path.resolve('dist');
  assert.equal(assetPath(root, '/'), path.join(root, 'index.html'));
  for (const pathname of ['/../secret', '/%2e%2e/secret', '/..%5csecret', '/%00', '/%ZZ']) assert.equal(assetPath(root, pathname), null);
  assert.match(CSP, /connect-src 'self'/);
  assert.match(CSP, /default-src 'none'/);
});
