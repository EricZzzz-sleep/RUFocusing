import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { createInterface } from 'node:readline';
import path from 'node:path';

export class Backend {
  constructor(executable, database, onFailure = () => {}) {
    this.secret = randomBytes(32).toString('hex');
    this.port = null;
    this.stopping = false;
    this.child = spawn(executable, ['--desktop'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
      env: { ...process.env, PYTHONNOUSERSITE: '1', RUFOCUSING_CACHE_DIR: path.join(path.dirname(database), 'cache', 'matplotlib') },
    });
    this.exited = new Promise(resolve => this.child.once('close', resolve));
    // Drain errors without writing private paths or session information to disk.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => {});
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => reject(new Error('The local service took too long to start.')), 30000);
      const lines = createInterface({ input: this.child.stdout });
      lines.on('line', line => {
        try {
          const event = JSON.parse(line);
          if (!settled && event.ready === true && Number.isInteger(event.port) && event.port > 0 && event.port <= 65535) {
            this.port = event.port;
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        } catch { /* Native libraries may print initialization messages. */ }
      });
      this.child.once('error', () => { clearTimeout(timer); reject(new Error('The bundled local service could not start.')); });
      this.child.once('exit', () => {
        clearTimeout(timer);
        this.port = null;
        if (!settled) reject(new Error('The local service stopped during startup.'));
        else if (!this.stopping) onFailure();
      });
    });
    this.child.stdin.write(JSON.stringify({ secret: this.secret, database }) + '\n');
  }

  command(command) {
    if (!this.stopping && this.child.stdin.writable) this.child.stdin.write(JSON.stringify({ command }) + '\n');
  }

  async request(method, route, body = '') {
    if (!this.port || this.stopping) throw new Error('The local service is unavailable.');
    return new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: this.port, path: route, method,
        headers: { 'X-RUFocusing-Token': this.secret, 'X-RUFocusing': '1',
          ...(method === 'POST' ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) },
      }, response => {
        const chunks = [];
        let length = 0;
        response.on('data', chunk => {
          length += chunk.length;
          if (length > 64 * 1024 * 1024) request.destroy(new Error('The response is too large.'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => resolve({ status: response.statusCode,
          type: response.headers['content-type'] || 'application/json', body: Buffer.concat(chunks) }));
      });
      request.setTimeout(15000, () => request.destroy(new Error('The local service did not respond.')));
      request.on('error', reject);
      request.end(method === 'POST' ? body : undefined);
    });
  }

  async stop() {
    if (this.stopping) return this.exited;
    this.stopping = true;
    this.port = null;
    if (this.child.stdin.writable) this.child.stdin.end(JSON.stringify({ command: 'shutdown' }) + '\n');
    const timer = setTimeout(() => {
      if (!this.child.pid || this.child.exitCode !== null) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => this.child.kill());
      } else {
        try { process.kill(-this.child.pid, 'SIGKILL'); } catch { this.child.kill('SIGKILL'); }
      }
    }, 6000);
    await this.exited;
    clearTimeout(timer);
    this.secret = '';
  }
}
