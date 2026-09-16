# Local app privacy

Camera images are processed on this device and are never saved or uploaded.

## What is retained

The local app analyzes live camera frames in memory. It keeps only the current
preview and bounded processing buffers, releases them when tracking stops, and
never creates video or image recordings. Camera cleanup also runs when a session
cannot be saved. Failed or stale frames cannot remain visible in the preview.

The database retains numerical presence/gaze observations, timelines, calibration
parameters, diagnostics, task names, reflections and tags needed for local reports.
Full face meshes and raw calibration training samples are not saved. These estimates
measure observed presence, not identity or mental concentration.

## Where data lives

- Packaged macOS app: `~/Library/Application Support/RUFocusing/sessions.sqlite3`.
- Packaged Windows app: `%LOCALAPPDATA%\RUFocusing\sessions.sqlite3`.
- Browser-based developer launcher: `.data/sessions.sqlite3` in the checkout.

The desktop browser session is in memory. A small native-library font cache can be
created in the local app-data folder. Installed binaries and the bundled model are
separate from session storage. No app-managed folder is placed in Documents, Desktop,
or a cloud-sync folder by default.

The app uses the operating-system account's file permissions. There is no app password
or application-level database encryption. Someone with access to the unlocked account,
an administrator, malware, or a device backup may access saved reports. The app does
not control OS backup, swap, crash handling or filesystem snapshots.

## Local communication

The packaged Electron page loads only bundled assets. Its sandbox has no Node.js
access. Approved API requests are forwarded by the main process to a service listening
only on `127.0.0.1` on a fresh port. Every packaged API request, including health and
camera preview, requires a random per-launch secret. That secret is passed through a
private parent/child pipe, never exposed to the page, URLs or command-line arguments.
The service shuts down when that pipe closes. The standalone development launcher
retains its existing loopback/origin/header checks and is not a public distribution.

The desktop app does not include Supabase, remote login, telemetry, crash-report
uploads, external fonts/scripts, model downloads, or automatic updates. Build-time
dependency/model downloads happen only on the developer's machine.

## Deletion and storage

Privacy & storage displays database and journal size. It lets the user confirm deletion
of a saved session or all history, and separately reset saved gaze setup. Related
session records are removed transactionally. Shared calibration data needed by surviving
reports and the currently saved gaze profile are preserved. Clearing all history also
removes historical diagnostics; resetting gaze setup preserves historical reports.

Deletion is available after the active session ends. Database compaction reclaims free
pages; if it fails, the UI distinguishes successful deletion from unsuccessful space
reclamation. Deletion is not a promise of forensic erasure from SSDs, backups or snapshots.
There are no video recordings to accumulate or delete after analysis.

## Separate public website

The public website in `apps/web` stores history in Supabase and has its own data controls.
It is not bundled in the downloadable app. This local-only policy does not describe
that separate website. See [public website documentation](public-web.md).
