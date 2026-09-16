import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const development = process.argv.includes('--dev');
if (!['darwin', 'win32'].includes(process.platform) || (process.platform === 'darwin' ? process.arch !== 'arm64' : process.arch !== 'x64')) {
  throw new Error('Package on macOS arm64 or Windows x64.');
}
if (!development) {
  const required = process.platform === 'darwin'
    ? ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
    : ['CSC_LINK', 'CSC_KEY_PASSWORD'];
  if (required.some(name => !process.env[name])) throw new Error('Release signing credentials are missing. Configure signing secrets or use package:dev for local testing.');
}
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: desktop, stdio: 'inherit', env });
  if (result.status !== 0) process.exit(result.status || 1);
}
run(process.execPath, ['scripts/python.mjs']);
// Invoke JS entry points directly: no shell command interpolation on Windows.
run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
const notices = [];
const lock = JSON.parse(fs.readFileSync(path.join(desktop, 'package-lock.json'), 'utf8'));
for (const [location, info] of Object.entries(lock.packages)) {
  if (!location || info.dev) continue;
  const directory = path.join(desktop, location);
  notices.push(`\n=== ${location} ${info.version} (${info.license || 'see license'}) ===\n`);
  for (const file of fs.readdirSync(directory).filter(file => /^(license|copying|notice)/i.test(file))) {
    if (fs.statSync(path.join(directory, file)).isFile()) notices.push(fs.readFileSync(path.join(directory, file), 'utf8'));
  }
}
// Electron's Chromium notices must travel with every installer as well.
createRequire(import.meta.url)('electron'); // Materialize the pinned build-time binary before reading its notices.
for (const file of ['LICENSE', 'LICENSES.chromium.html']) notices.push(fs.readFileSync(path.join(desktop, 'node_modules/electron/dist', file), 'utf8'));
fs.writeFileSync(path.join(desktop, 'build/JS-NOTICES.txt'), notices.join('\n'));
run(process.execPath, ['node_modules/electron-builder/out/cli/cli.js', '--config', 'electron-builder.cjs', '--publish', 'never'],
  { ...process.env, RUFOCUSING_DEV_PACKAGE: development ? '1' : '0', ...(development ? { CSC_IDENTITY_AUTO_DISCOVERY: 'false' } : {}) });
const output = path.join(desktop, 'release');
const suffix = development ? '-dev' : '';
const files = fs.readdirSync(output).filter(file => file.endsWith(`${suffix}.dmg`) || file.endsWith(`${suffix}.exe`))
  .filter(file => development || !file.includes('-dev.'));
if (!files.length) throw new Error('No installer was produced.');
fs.writeFileSync(path.join(output, development ? 'SHA256SUMS-dev.txt' : 'SHA256SUMS.txt'), files.map(file => `${createHash('sha256').update(fs.readFileSync(path.join(output, file))).digest('hex')}  ${file}`).join('\n') + '\n');
