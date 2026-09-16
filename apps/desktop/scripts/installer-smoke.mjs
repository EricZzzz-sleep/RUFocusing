import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(desktop, 'release');
const extension = process.platform === 'darwin' ? '.dmg' : '.exe';
const candidates = fs.readdirSync(release).filter(file => file.endsWith(extension))
  .sort((a, b) => fs.statSync(path.join(release, b)).mtimeMs - fs.statSync(path.join(release, a)).mtimeMs);
if (!candidates.length) throw new Error('Build an installer first.');
const installer = process.argv[2] ? path.resolve(process.argv[2]) : path.join(release, candidates[0]);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rufocusing-install-'));
let mounted = false, installed;
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.status !== 0) throw new Error(`Installation smoke command failed: ${path.basename(command)}`);
}
try {
  if (process.platform === 'darwin') {
    const mount = path.join(temporary, 'volume');
    fs.mkdirSync(mount);
    run('hdiutil', ['attach', installer, '-readonly', '-nobrowse', '-mountpoint', mount]);
    mounted = true;
    installed = path.join(temporary, 'RUFocusing.app');
    run('ditto', [path.join(mount, 'RUFocusing.app'), installed]);
    run('hdiutil', ['detach', mount]);
    mounted = false;
    run('codesign', ['--verify', '--deep', '--strict', installed]);
    run(process.execPath, [path.join(desktop, 'scripts/smoke.mjs')], { ...process.env,
      RUFOCUSING_TEST_EXECUTABLE: path.join(installed, 'Contents/MacOS/RUFocusing') });
  } else if (process.platform === 'win32') {
    const existing = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'RUFocusing'], { stdio: 'ignore' });
    if (existing.status === 0) throw new Error('Use a clean Windows test account: RUFocusing is already installed.');
    installed = path.join(temporary, 'RUFocusing');
    // NSIS requires the unquoted /D argument last; no shell evaluates this command.
    const result = spawnSync(installer, ['/S', `/D=${installed}`], { stdio: 'inherit', windowsVerbatimArguments: true });
    if (result.status !== 0) throw new Error('The Windows installer failed.');
    run(process.execPath, [path.join(desktop, 'scripts/smoke.mjs')], { ...process.env,
      RUFOCUSING_TEST_EXECUTABLE: path.join(installed, 'RUFocusing.exe') });
  } else throw new Error('Install smoke requires macOS or Windows.');
  console.log('Installer extraction/installation and installed application smoke passed.');
} finally {
  if (mounted) spawnSync('hdiutil', ['detach', path.join(temporary, 'volume')], { stdio: 'inherit' });
  if (process.platform === 'win32' && installed && fs.existsSync(path.join(installed, 'Uninstall RUFocusing.exe'))) {
    spawnSync(path.join(installed, 'Uninstall RUFocusing.exe'), ['/S'], { stdio: 'inherit' });
  }
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
