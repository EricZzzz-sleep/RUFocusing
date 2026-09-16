# Downloadable desktop app

The desktop app wraps the existing local React/Python implementation in Electron.
It includes the Python runtime, native vision libraries, SQL migrations and verified
face model. End users need no development tools or internet connection, including
on first launch. There is no account, password, cloud sync, telemetry, crash upload,
or update service. The public website is a separate application.

## Install and use

- macOS: Apple Silicon DMG. Open the image and drag RUFocusing into Applications.
- Windows: x64 NSIS installer. Install for the current user; administrator access is
  not required. Windows ARM and Intel Macs are not release targets.
- Open the app, choose Record, and start a session. Camera use is optional. Grant
  camera access to RUFocusing in system settings if requested, then retry.
- Minimizing keeps a session running. Sleep pauses it; resume explicitly after waking.
  Closing the window quits, releases the camera, and saves an interrupted session.
- Privacy & storage shows database size and provides confirmed deletion of one
  session, all history, or saved gaze setup. End an active session before deletion.
- Update by installing a newer release. The database lives outside the installation
  directory and is preserved across upgrades and uninstall/reinstall.

Development installers have `-dev` in their names and are not notarized/publicly
signed. Public distribution requires the signed build described below. No download
is published automatically by this repository's workflow.

## Build locally

Use Python **3.14.3** and Node.js **22.12+** on the target architecture. JavaScript
dependencies are locked in package-lock.json. Python runtime and bundler dependencies
are pinned in `apps/desktop/packaging/requirements.txt`.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r apps/desktop/packaging/requirements.txt
npm ci --prefix apps/desktop
npm --prefix apps/desktop run package:dev
```

On Windows, use `python -m venv .venv`, then
`.venv\Scripts\python.exe -m pip install -r apps/desktop/packaging/requirements.txt`.
The build script finds that virtual environment automatically. To use a different
interpreter, set `RUFOCUSING_PYTHON` to its executable path.

The build downloads and checksum-verifies the model, freezes the backend, runs native
inference on a synthetic blank image in a spawned process, compiles React, bundles
dependency notices, and produces the installer plus SHA256SUMS in
`apps/desktop/release/`. No webcam is opened by build or automated tests.

To run the desktop shell without making an installer:

```sh
npm --prefix apps/desktop run backend:build
npm --prefix apps/desktop run build
npm --prefix apps/desktop run desktop
```

`make run` still starts the browser-based development workspace and keeps its existing
`.data/sessions.sqlite3` history. Packaged installations start with their own database;
there is no implicit import of development history or Supabase data.

## Release signing and CI

Run `npm --prefix apps/desktop run package:release` on each target OS. It fails before
building when credentials are missing; electron-builder also requires a real signing
identity. The macOS build enables notarization and production entitlements. Only
development signing permits disabling library validation.

| Platform | Required environment variables |
| --- | --- |
| macOS | `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Windows | `CSC_LINK`, `CSC_KEY_PASSWORD` |

`CSC_LINK` points to the signing certificate (or a supported encoded value).
Keep signing material outside the repository. In GitHub Actions, configure
`MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, and the
three Apple secrets. Dispatch **Desktop installers** with `signed` enabled for signed
release candidates. Pull requests build development installers without secrets.

Each OS job runs regression tests, builds its own native backend and installer,
and exercises the backend, Electron window, and installed app with isolated temporary data. Artifacts
include installers, checksums, notices and a UI screenshot. After the remaining manual
checks below, attach the signed installers and checksums to the project's download
release. Dependencies and model licenses are bundled in Resources (macOS) or resources
(Windows); the app uses the repository's Apache-2.0 license.

## Verification

```sh
.venv/bin/python -m unittest discover -s tests -v
npm --prefix apps/desktop test
npm --prefix apps/desktop run test:shell
npm --prefix apps/desktop run build
npm --prefix apps/desktop run test:backend
npm --prefix apps/desktop run test:desktop
npm --prefix apps/desktop run test:installer
```

The backend and desktop checks require `backend:build` first. For a packaged executable, set
`RUFOCUSING_TEST_EXECUTABLE` to its path before `test:desktop`. The test script sets
`RUFOCUSING_TEST_DATA_DIR` to a temporary directory and never reads normal user history.
Do not set that variable in normal use. `test:installer` installs the latest built
installer into a temporary location, runs the same desktop checks, then removes the
test installation. Run Windows installation tests on a disposable machine or CI runner
because NSIS also updates the current user's uninstall registration.

Automated checks cover authenticated API access and token rotation, renderer isolation,
blocked external fetches, offline renderer operation, Chromium network-log checks,
session saving, simulated sleep, restart persistence,
confirmed deletion, rollback, failed compaction, camera cleanup after failed writes,
abrupt-backend crash recovery, and shutdown on parent-pipe closure. Native inference uses synthetic frames.

Before publishing each OS release, also verify on a clean machine:

1. Install with network disabled; launch, record, analyze and reopen history offline.
2. Deny camera permission, grant it in settings, retry, and complete actual gaze setup.
3. Confirm fullscreen calibration, preview, camera disable, break, sleep/wake, and quit
   release the physical camera. Check abrupt application/backend termination too.
4. Monitor process network traffic throughout camera and report use; there should be
   no external requests. The loopback backend is expected.
5. Upgrade over an older installation and verify history. Verify uninstallation keeps
   history unless the user cleared it first.
6. Validate macOS signing/notarization and Windows publisher identity. Do not publish
   development artifacts as public releases.

These physical-device and public-signing checks cannot be replaced by synthetic tests.
