# RUFocusing

A local study timer with a simple timeline of **Deep study**, **Normal**, and **Distracted** periods. Built with React, TypeScript, and Python. Sessions and gaze setup stay in SQLite on your device; video is never saved.

## Run

Requires Python 3.12+, Node.js 22.12+, npm, and make. Tested on an Apple Silicon Mac.

```sh
make run
```

The first run installs dependencies and downloads the face model, then opens **http://127.0.0.1:5173**. Subsequent sessions work offline. Ctrl+C in the launching terminal stops the services and releases the camera.

```sh
make run OPEN=0
make run PORT=5174 API_PORT=18766
make test
make build
```

The launcher reuses an existing compatible instance of this checkout. Stop an older running backend before starting the updated app: this release requires **API version 5** and transactionally migrates local databases to **schema version 5**. Existing session records are preserved; older app versions cannot reopen the upgraded database.

## Use

1. Open **Record**, enter a task, choose a study mode, and start your session.
2. Optionally enable **Use camera** in **Camera & gaze**. Drag the preview title bar or camera image to reposition it; its position is remembered while the page stays open. Preview, retry, and camera toggles remain available during study. Closing a preview during a session keeps tracking on; closing setup preview releases the camera.
3. Follow your **Estimated study periods** timeline. Select a period for its time and duration. Use the information control for definitions.
4. **Take a break**, **Resume session**, or **End & save session**. The saved report shows the same timeline and totals. Optional ratings and personal timeline tags are inside **Reflection**.
5. In **Analysis**, choose a date range to see the three totals and search your session history.

The timer continues if the browser tab closes. Sessions interrupted by shutdown reopen at their last saved checkpoint. Camera access remains off during breaks. If the camera cannot open, allow access for Python/the launching terminal in macOS System Settings → Privacy & Security → Camera, then choose **Retry camera**.

## Estimated study periods

- **Deep study:** an uninterrupted period of detected presence lasting at least ten minutes. When the live period reaches ten minutes, its whole duration becomes Deep study.
- **Normal:** shorter presence periods.
- **Distracted:** time classified as away by the existing detector, after at least ten seconds without a face.

These are presence-based estimates, not measurements of mental concentration. Gaze direction and personal ratings do not assign these states. Breaks, gaze setup, missing camera data, and unreliable observations split continuity and appear as neutral gaps; they do not count toward the three totals. Sessions without usable evidence show **No tracking data**. Historical sessions with incomplete diagnostic timing remain unavailable for these estimates.

Date ranges include completed and interrupted sessions, grouped by their local start date. The overview sums backend period totals for the selected sessions. Personal reflections and tags remain separate from automatic estimates.

## Saved gaze setup

Enable the camera and select **Set up gaze**. Follow the fullscreen targets once; the existing nine training targets and four validation targets remain internal to the guided setup. Only an accepted model is saved.

The successful setup is reused across sessions, preview closure, camera toggles, breaks, and app restarts. Camera/display compatibility and seating are checked before estimates resume. Temporary tracking loss clears the current point without deleting setup. Use **Redo setup** when needed, or **Setup options → Reset gaze setup** to forget the saved profile. A cancelled, failed, or unsaved replacement retains the previous profile.

Existing installations complete setup once to establish the reusable profile. Previous session calibration records remain historical records and are not automatically promoted. The device profile has no expiry and is independent of any one session; session links preserve the identity of reused models.

Gaze maps, quality readings, validation errors, reliability trials, and diagnostic tables are absent from the user interface. Developer APIs and stored diagnostics remain available; see [gaze tracking](docs/gaze-tracking.md) and [diagnostic protocol](docs/gaze-reliability.md). Physical webcam accuracy has not been established by the synthetic tests.

## Development and validation

- `apps/desktop`: React workspace, selectable SVG study timeline, and setup controls.
- `apps/vision`: camera processing, calibrated gaze estimator, and loopback API.
- `core`: session lifecycle, presence rules, and shared study-period calculations.
- `database`: SQLite records, device gaze profile, calibration/session links, and migrations.

Run `make test` for Python and frontend tests, TypeScript checks, and the production build. Tests use synthetic camera observations and temporary databases; they do not activate the webcam. Browser layout checks cover desktop and a 390px mobile viewport, keyboard selection, neutral gaps, and overflow.

Raw frames, full face meshes, and video are never stored. Internal numerical observations, historical calibration parameters, diagnostics, reflections, and tags remain local.
