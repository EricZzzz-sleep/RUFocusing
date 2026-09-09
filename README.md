# RUFocusing

A local study-session app. **Phase 1 is implemented:** a live camera preview, optional webcam face detection, approximate head pose, estimated away detection, a session timer, SQLite storage, and saved timelines.

## Run

Requires **Python 3.12+**, **Node.js 22.12+ with npm**, and **make**. Tested on an Apple Silicon Mac.

From this repository:

```sh
make run
```

The first run installs local Python/frontend dependencies and downloads the pinned face model. It starts both services and opens **http://127.0.0.1:5173** in your browser. Subsequent runs reuse the installed dependencies and model; session processing works offline. If this checkout is already running on the selected ports, `make run` reopens its page and leaves the existing session running.

**Ctrl+C** in the terminal that originally started the servers stops both services and releases the camera. Alternative options:

```sh
make run OPEN=0                       # Start without opening a browser
make run PORT=5174 API_PORT=18766     # Use different ports
make test                           # Python + frontend tests, type check/build
make build                          # Frontend production build
```

The backend normally uses port **18765**. The launcher checks both services before reusing an existing app. If a different application or an incomplete/older server occupies a port, stop the previous server with Ctrl+C in its terminal or choose another pair of ports. If automatic browser opening fails, open the printed URL manually; the servers keep running.

## Use

1. Enter a task and select a study mode.
2. Optionally check **Use webcam observations**. A small live preview opens so you can adjust the camera framing before starting. On macOS, allow camera access for Python/the launching terminal in **System Settings → Privacy & Security → Camera**, then select **Retry camera** if needed.
3. Start the session. Use **Show camera preview** to reopen the small preview while tracking. **Mirror preview** changes only the display; detection uses the original image.
4. Use **Take a break** / **Resume session** to pause and resume tracking.
5. **End & save session** opens the report. Select a history entry to reopen its timeline.

Closing a preview before a session stops the camera. An abandoned setup preview expires after eight seconds without frame requests. Closing the preview during a session keeps observation tracking on; breaks and session end stop it. No video footage is saved.

The timer continues if the browser tab closes; stop the session in the page or stop `make run`. Uncleanly closed sessions reopen as interrupted at their last saved checkpoint.

**At desk** means one face was detected. **Away** means no face was detected for at least 10 seconds of fresh observations. Camera errors, multiple faces, short absences, and missing data are **Unknown**. Looking down alone never means away. These are presence estimates, not measures of focus.

## Camera setup and recovery

The preview and observations panel share these states:

| State | Meaning / action |
| --- | --- |
| **Off** | Camera is released, including during breaks and after ending a session. |
| **Starting** | Camera and face detection are initializing. Retry is disabled; opening a session reuses this startup. |
| **Ready** | Fresh camera frames and face observations are available. No face or multiple faces can still be detected in this state. |
| **Unavailable** | Startup failed, processing stopped, or observations are stale. Follow the message, then select **Retry camera**. |

Startup has a **15-second timeout**; observations older than **2 seconds** become unavailable and the old preview frame is hidden. A fresh observation can restore a stalled stream. Retry keeps the same session, elapsed time, and existing timeline. Time without camera observations remains **Unknown**; the timer continues.

If the camera cannot open, check **System Settings → Privacy & Security → Camera** for Python or the app that launched it, connect the camera, and close other apps that may be using it. Then choose **Retry camera**. The browser displays Python's local preview; the Python process owns camera access. If a macOS permission change explicitly requires relaunching the launching app, first end and save the session before doing so. For a face-model initialization error, check the terminal; a missing model can be restored with `make install`.

## Validation

`make test` runs synthetic camera/session tests using temporary SQLite databases, frontend component tests with mocked API responses, TypeScript checks, and a production build. These tests never activate the webcam.

Automated coverage includes camera startup failure/timeout, native process exit, stale frames, repeated retry during startup, recovery without losing session time, preview close during a pending request, keyboard close/focus restoration, and the existing presence/timeline calculations. A regression test uses actual spawned workers with synthetic frames to verify that a worker dying while holding its frame lock and repeated process termination cannot block retry or the timer.

Real-camera verification is recorded separately from those tests. The default webcam on the development Apple Silicon Mac has shown **Starting → Ready**, live JPEG preview, one-face detection, and head-angle readings with this implementation. The physical looking-down and 15-second leave/return walkthrough requires a person at the camera; automated observations do not substitute for that check.

## Local data

SQLite records are stored in `.data/sessions.sqlite3`. The face model is cached in `core/models/face_landmarker.task`. Both are ignored by Git. Raw frames stay in memory. While the preview is open, the latest JPEG is delivered over loopback to the local browser; no video is saved or uploaded to an external service.

## Structure

```text
apps/
├── desktop/        # src/, components/, pages/, src-tauri/; local React UI and launcher
└── vision/         # camera.py, face.py, pose.py, worker.py; other detector placeholders
core/
├── session.py      # Timer, presence rules, and session lifecycle
├── features/       # Image-free observation type; future feature windows
├── behavior/       # Away rule; future classifiers
├── analytics/      # Timeline totals and longest observed presence block
└── models/         # Downloaded model cache
database/           # SQLite schema, store, and future migrations
extensions/         # Chrome and VS Code placeholders
tests/              # Synthetic observations and temporary databases
docs/               # Architecture and privacy
```

Tauri packaging, gaze/body/phone detection, computer activity tracking, and personal focus analytics remain future work. The current desktop frontend runs locally in your browser.

See [architecture](docs/architecture.md), [privacy](docs/privacy.md), and the [Apache 2.0 license](LICENSE).
