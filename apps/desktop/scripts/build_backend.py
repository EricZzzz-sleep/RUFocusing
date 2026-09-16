"""Build on the target OS; installation-time downloads are never needed."""
from pathlib import Path
import hashlib
import importlib.metadata
import platform
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
DESKTOP = ROOT / 'apps/desktop'
sys.path.insert(0, str(ROOT))

if (sys.platform, platform.machine().lower()) not in {('darwin', 'arm64'), ('win32', 'amd64')}:
    raise SystemExit('Build on an Apple Silicon Mac or an x64 Windows machine.')

from apps.vision.face import ensure_model, MODEL_SHA256
model = ensure_model()  # Build-time only; pins and checks the downloaded model.
assert hashlib.sha256(model.read_bytes()).hexdigest() == MODEL_SHA256
subprocess.run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean',
                '--distpath', str(DESKTOP / 'build'), '--workpath', str(DESKTOP / 'build/pyinstaller'),
                str(DESKTOP / 'packaging/backend.spec')], cwd=ROOT, check=True)

notices = ['RUFocusing third-party notices\n', (ROOT / 'LICENSE').read_text(),
           'Face Landmarker model: https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
           'Model SHA-256: ' + MODEL_SHA256]
for distribution in sorted(importlib.metadata.distributions(), key=lambda item: item.metadata['Name'].lower()):
    notices.append('\n=== ' + distribution.metadata['Name'] + ' ' + distribution.version + ' ===\n')
    notices.append(distribution.metadata.get('License-Expression') or distribution.metadata.get('License') or 'See included license text.')
    for file in distribution.files or []:
        if any(term in Path(str(file)).name.lower() for term in ('license', 'copying', 'notice')):
            location = distribution.locate_file(file)
            if location.is_file():
                notices.append(location.read_text(errors='replace'))
(DESKTOP / 'build/PYTHON-NOTICES.txt').write_text('\n'.join(notices), encoding='utf-8')
executable = DESKTOP / 'build/backend' / ('rufocusing-service.exe' if sys.platform == 'win32' else 'rufocusing-service')
subprocess.run([str(executable), '--self-test'], check=True, timeout=90)
