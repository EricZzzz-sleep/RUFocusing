import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Backend } from '../electron/backend.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(path.join(os.tmpdir(), 'rufocusing-backend-'));
const executable = process.env.RUFOCUSING_TEST_BACKEND || path.join(root, 'build/backend', process.platform === 'win32' ? 'rufocusing-service.exe' : 'rufocusing-service');
let backend;
try {
  backend = new Backend(executable, path.join(directory, 'sessions.sqlite3'));
  await backend.ready;
  const oldSecret = backend.secret;
  const publicResponse = await fetch(`http://127.0.0.1:${backend.port}/api/health`);
  assert.equal(publicResponse.status, 403);
  let response = await backend.request('POST', '/api/sessions/start', JSON.stringify({ task: 'Crash checkpoint', mode: 'Math', camera: false }));
  assert.equal(response.status, 200);
  const identifier = JSON.parse(response.body).active.id;
  backend.command('suspend');
  response = await backend.request('GET', '/api/state');
  // Commands and HTTP use different threads; repeat with bounded polling.
  for (let attempt = 0; JSON.parse(response.body).active.status !== 'break' && attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    response = await backend.request('GET', '/api/state');
  }
  assert.equal(JSON.parse(response.body).active.status, 'break');
  await backend.stop();
  backend = new Backend(executable, path.join(directory, 'sessions.sqlite3'));
  await backend.ready;
  assert.notEqual(backend.secret, oldSecret);
  response = await backend.request('GET', '/api/state');
  assert.equal(JSON.parse(response.body).history[0].status, 'interrupted');
  const outdated = await fetch(`http://127.0.0.1:${backend.port}/api/state`, { headers: { 'X-RUFocusing-Token': oldSecret } });
  assert.equal(outdated.status, 403);
  response = await backend.request('POST', '/api/storage/delete-session', JSON.stringify({ session_id: identifier }));
  assert.equal(JSON.parse(response.body).sessions, 0);
  await backend.request('POST', '/api/sessions/start', JSON.stringify({ task: 'Abrupt exit', mode: 'Reading', camera: false }));
  backend.child.kill('SIGKILL');
  await backend.exited;
  await backend.stop();
  backend = new Backend(executable, path.join(directory, 'sessions.sqlite3'));
  await backend.ready;
  response = await backend.request('GET', '/api/state');
  assert.equal(JSON.parse(response.body).history[0].status, 'interrupted');
  // Parent disappearance is conveyed by stdin EOF, including abrupt desktop exits.
  backend.child.stdin.end();
  await Promise.race([backend.exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Backend did not exit on parent EOF.')), 10000); timer.unref(); })]);
  assert.equal((await readdir(directory)).some(file => /\.(mp4|webm|jpg|png)$/.test(file)), false);
  console.log('Frozen backend smoke passed: auth, token rotation, sleep, restart, crash recovery, deletion and parent-exit shutdown.');
} finally { await backend?.stop(); await rm(directory, { recursive: true, force: true }); }
