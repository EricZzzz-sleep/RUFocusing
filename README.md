# RUFocusing

A local study-session app. Record study sessions, control webcam observations, and review saved timelines and daily study trends. Optional local face detection supplies presence estimates and approximate head pose; session data stays in SQLite on this device.

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
3. Start the session. In **Observations**, toggle **Webcam observations** at any time. Turning it off releases the camera and marks subsequent study time unknown while the timer continues. Turning it on opens the preview. Use **Show camera preview** to reopen it while tracking. **Mirror preview** changes only the display; detection uses the original image.
4. Use **Take a break** / **Resume session** to pause and resume tracking. The camera stays off during breaks; changing its setting then determines whether it restarts on resume.
5. **End & save session** opens the report with study/break time, the presence breakdown, longest at-desk period, observation coverage, and timeline. Select a history entry to reopen it.
6. Choose **Last 7 days**, **Last 30 days**, or **All time** to explore saved sessions. Search tasks and filter history by mode or status. These history filters do not change the overview or chart.

Closing a preview before a session stops the camera. An abandoned setup preview expires after eight seconds without frame requests. Closing the preview during a session keeps observation tracking on; breaks and session end stop it. No video footage is saved.

The timer continues if the browser tab closes; stop the session in the page or stop `make run`. Uncleanly closed sessions reopen as interrupted at their last saved checkpoint.

**At desk** means one face was detected. **Away** means no face was detected for at least 10 seconds of fresh observations. Camera errors, multiple faces, short absences, and missing data are **Unknown**. Looking down alone never means away. These are presence estimates, not measures of focus.

## Experimental gaze tracking

With webcam observations enabled, select **Calibrate gaze** in the **Screen gaze** panel. Follow nine fullscreen targets and four separate accuracy checks. A point appears only after validation passes and while fresh, usable eye observations are available. New sessions require calibration; normal breaks and camera toggles retain it when geometry stays valid. Saved reports include separate gaze coverage and screen-region durations.

Gaze tracking is experimental and does not measure concentration. Physical accuracy has not yet been established. See [setup, model limits, APIs, and the physical validation checklist](docs/gaze-tracking.md).

This update upgrades local SQLite storage to schema version 2. Restart any older running backend before using it; `make run` will not reuse an older API version. Existing history is preserved, and sessions without gaze observations are labeled accordingly.

## Reading your analysis

The dashboard defaults to the last seven local calendar days, including today. Date ranges apply to the overview, daily chart, and history. Completed and interrupted sessions are included; active sessions enter the analysis after saving. Sessions crossing midnight are attributed entirely to their local start date. Days without saved sessions show zero.

**Study time** is total session time minus explicit breaks. **Observation coverage** is `(at-desk time + estimated away time) / study time`, shown as N/A when there is no study time. Aggregate coverage is weighted by duration, not the average of individual percentages. A timer-only session has unknown study time and 0% coverage. The final camera setting does not describe the whole session; its timeline does.

The daily stacked chart shows at-desk, away, and unknown study durations with a zero baseline. Open **View daily data table** for exact values, session counts, breaks, and coverage. Longer periods scroll horizontally. Unknown includes camera-off time, short absences, multiple faces, failures, and unreliable observations. Presence does not measure cognitive focus.

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

Automated coverage includes live camera setting changes, break/resume settings, idempotent toggles, weighted coverage, local date boundaries, history filtering, save/start failure recovery, reconnection, camera startup failure/timeout, native process exit, stale frames, repeated retry during startup, recovery without losing session time, preview close during a pending request, keyboard close/focus restoration, and the existing presence/timeline calculations. A regression test uses actual spawned workers with synthetic frames to verify that a worker dying while holding its frame lock and repeated process termination cannot block retry or the timer.

Frontend browser validation for the dashboard uses a temporary SQLite database and synthetic camera observations. It covers date ranges, history filtering, recording, camera toggles, break/resume, refresh recovery, save failure/retry, report keyboard focus, and layouts from 320 to 1440 pixels. No physical camera is activated by these checks.

Real-camera verification is recorded separately from those tests. The new live-toggle walkthrough with physical hardware remains a manual check: start timer-only, enable observations, verify preview, hide/reopen preview, disable observations and confirm camera release, enable during a break and verify it starts only on resume, then save. The default webcam on the development Apple Silicon Mac has shown **Starting → Ready**, live JPEG preview, one-face detection, and head-angle readings with this implementation. The physical looking-down and 15-second leave/return walkthrough requires a person at the camera; automated observations do not substitute for that check.

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

Tauri packaging, body/phone detection, computer activity tracking, and personal focus analytics remain future work. Screen gaze is an experimental calibrated feature. The current desktop frontend runs locally in your browser.

See [architecture](docs/architecture.md), [privacy](docs/privacy.md), and the [Apache 2.0 license](LICENSE).
