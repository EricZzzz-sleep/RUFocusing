import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const python = process.env.RUFOCUSING_PYTHON || path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const result = spawnSync(python, [path.join(root, 'apps/desktop/scripts/build_backend.py')], { cwd: root, stdio: 'inherit' });
if (result.error) console.error('Create .venv and install apps/desktop/packaging/requirements.txt first.');
process.exit(result.status ?? 1);
