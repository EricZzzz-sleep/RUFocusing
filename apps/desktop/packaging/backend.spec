from pathlib import Path
from PyInstaller.utils.hooks import collect_all

root = Path(SPECPATH).resolve().parents[2]
datas, binaries, hiddenimports = collect_all('mediapipe', filter_submodules=lambda name: '.test' not in name)
datas += [(str(root / 'database' / name), 'database') for name in (
    'schema.sql', 'gaze_v2.sql', 'diagnostics_v3.sql', 'study_patterns_v4.sql', 'gaze_profile_v5.sql')]
datas += [(str(root / 'core/models/face_landmarker.task'), 'core/models')]
a = Analysis([str(root / 'apps/desktop/packaging/service.py')], pathex=[str(root)],
             binaries=binaries, datas=datas, hiddenimports=hiddenimports,
             excludes=['pytest', 'tkinter', 'IPython', 'tensorflow', 'torch'], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='rufocusing-service',
          debug=False, strip=False, upx=False, console=True)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='backend')
