# RUFocusing

A local study-session app built with React, TypeScript, and Python. Record sessions, control webcam observations, explore study patterns, and add personal reflections. Session records stay in SQLite on your device; video is never saved.

- **Analysis:** saved metrics, daily charts, date filters, searchable history, and detailed reports.
- **Record:** task and mode setup, timer, breaks, webcam controls, a draggable preview, and gaze calibration.
- **Study patterns:** sustained at-desk periods and possible interruptions from recorded presence, with separate self-reported concentration, distraction, flow, and timeline tags.
- **Experimental screen gaze:** calibrated gaze estimates, screen-region summaries, accuracy checks, and guided reliability trials.

Camera observations describe presence and estimated gaze location. They do not establish concentration, distraction, or flow; those experiences are reported by you.

## Run

Requires **Python 3.12+**, **Node.js 22.12+ with npm**, and **make**. Tested on an Apple Silicon Mac.

From this repository:

```sh
make run
```

The first run installs local Python/frontend dependencies and downloads the pinned face model. It starts both services and opens **http://127.0.0.1:5173** in your browser. Subsequent runs reuse the installed dependencies and model; session processing works offline. If this checkout is already running on the selected ports, `make run` reopens its page and leaves the existing session running.

**Ctrl+C** in the terminal that originally started the servers stops both services and releases the camera. Alternative options:

```sh
make run OPEN=0                      # Start without opening a browser
make run PORT=5174 API_PORT=18766     # Use different ports
make test                           # Python + frontend tests, type check/build
make build                          # Frontend production build
```

The backend normally uses port **18765**. The launcher checks both services before reusing an existing app. If a different application or an incomplete/older server occupies a port, stop the previous server with Ctrl+C in its terminal or choose another pair of ports. If automatic browser opening fails, open the printed URL manually; the servers keep running.

## Use

1. Open the **Record** tab, enter a task, and select a study mode. **Analysis** opens by default and contains saved metrics, the daily chart, and session history.
2. Optionally check **Use webcam observations**. A small live preview opens so you can adjust the camera framing before starting. On macOS, allow camera access for Python/the launching terminal in **System Settings → Privacy & Security → Camera**, then select **Retry camera** if needed.
3. Start the session. In **Observations**, toggle **Webcam observations** at any time. Turning it off releases the camera and marks subsequent study time unknown while the timer continues. Turning it on opens the preview. Use **Show camera preview** to reopen it while tracking. **Mirror preview** changes only the display; detection uses the original image.
4. Use **Take a break** / **Resume session** to pause and resume tracking. The camera stays off during breaks; changing its setting then determines whether it restarts on resume.
5. **End & save session** switches to Analysis and opens the report with study patterns, presence evidence, session timing, and any recorded gaze data. Optionally save a reflection or add personal timeline tags. Select a history entry to reopen and edit them later.
6. In **Analysis**, choose **Last 7 days**, **Last 30 days**, or **All time** to explore saved sessions. Search tasks and filter history by mode or status. These history filters affect only the history list; the overview, daily chart, and Study patterns use the date range.

Switch between **Analysis** (`#analysis`) and **Record** (`#record`) using the navigation tabs. Browser Back/Forward and direct links work; task inputs and analysis filters survive tab switches. A running session continues on Analysis, with a **Return to session** link. Leaving Record hides its preview; reopen it explicitly after returning. Leaving pre-session setup releases the camera and clears setup calibration. Leaving unfinished calibration cancels it.

Drag the dotted handle in the camera preview header with a mouse, touch, or pen to reposition it. When the handle has keyboard focus, arrow keys move it 10 pixels, Shift+arrow moves it 40 pixels, and Home restores the bottom-right position. The preview stays within the visible screen and remembers its position across reopening and navigation until the page reloads. Close, Retry, Mirror, and preview scrolling remain independent of dragging.

Closing a preview before a session stops the camera. An abandoned setup preview expires after eight seconds without frame requests. Closing the preview during a session keeps observation tracking on; breaks and session end stop it. No video footage is saved.

The timer continues if the browser tab closes; stop the session in the page or stop `make run`. Uncleanly closed sessions reopen as interrupted at their last saved checkpoint.

**At desk** means one face was detected. **Away** means no face was detected for at least 10 seconds of fresh observations. Camera errors, multiple faces, short absences, and missing data are **Unknown**. Looking down alone never means away. These are presence estimates, not measures of focus.

## Experimental gaze tracking

On **Record**, with webcam observations enabled, select **Calibrate gaze** in the **Screen gaze** panel. Follow nine training targets and four separate validation targets in fullscreen. Calibration requires median error ≤10% and p90 error ≤20% of the display diagonal. A point appears only after validation passes and while fresh, usable eye observations are available.

Each new session requires calibration; accepted setup calibration can transfer into the immediately following session. Normal breaks and camera toggles retain it when the camera/display configuration and seating geometry remain valid. Camera failure or retry, display changes, and sustained seating changes require recalibration. Saved reports include separate gaze coverage and screen-region durations.

**Check gaze accuracy** runs nine independent targets through the accepted estimator without updating the calibration model. A complete check passes or fails the same error gates; missing evidence produces **Incomplete**. Failed checks suppress estimates until recalibration. Checks require an already enabled camera and never activate it themselves.

**Start reliability trial** guides an active, calibrated session through an initial accuracy check and follow-up reminders around 10 and 25 minutes of trial study time. Checks require your action; reminders never force a break or end a session. Trial time excludes breaks and diagnostic windows. Review errors, missing observations, coverage, and JSON downloads in recent diagnostics or the saved session report. Coverage is measured as a baseline without a pass/fail threshold. See the [reliability workflow and pending physical acceptance record](docs/gaze-reliability.md).

Gaze tracking is experimental and does not measure concentration. Physical accuracy has not yet been established. See [setup, model limits, APIs, and the physical validation checklist](docs/gaze-tracking.md).

## Reading your analysis

The dashboard defaults to the last seven local calendar days, including today. Date ranges apply to the overview, daily chart, Study patterns, and history. Completed and interrupted sessions are included; active sessions enter the analysis after saving. Sessions crossing midnight are attributed entirely to their local start date. Days without saved sessions show zero.

**Study time** is total session time minus explicit breaks. **Observation coverage** is `(at-desk time + estimated away time) / study time`, shown as N/A when there is no study time. Aggregate coverage is weighted by duration, not the average of individual percentages. A timer-only session has unknown study time and 0% coverage. The final camera setting does not describe the whole session; its timeline does.

The daily stacked chart shows at-desk, away, and unknown study durations with a zero baseline. Open **View daily data table** for exact values, session counts, breaks, and coverage. Longer periods scroll horizontally. Unknown includes camera-off time, short absences, multiple faces, failures, and unreliable observations. Presence does not measure cognitive focus.

### Study patterns and reflection

Open a saved session for **Study patterns & reflection**. Reports keep two evidence layers separate:

| Indicator | Evidence and meaning |
| --- | --- |
| **Sustained at-desk periods** | Continuous recorded presence lasting at least ten minutes, shown as count, total duration, and longest qualifying period. Away, unknown, breaks, calibration, and accuracy checks split continuity. |
| **Possible interruptions** | Recorded away episodes outside breaks and diagnostics, with their timing and duration. Their cause is unknown; initial unknown absence time is not backfilled. |
| **Behavioral observation coverage** | Recorded at-desk plus away time divided by study time outside breaks and diagnostics. Unknown time stays in the denominator; zero eligible time is N/A. |
| **Personal ratings** | Optional concentration and distraction-frequency answers from 1–5, plus **Self-reported flow** as Yes / No / Unsure. |
| **Personal timeline tags** | Times you label **Focused**, **Distracted**, or **Flow**, shown separately from recorded observations. Individual Focused or Flow tags lasting at least ten minutes count as **Self-reported sustained focus**. |

“Deep study” means sustained concentration here. Ten minutes is a versioned product default, not a scientifically validated concentration threshold. At-desk periods may support sustained study but do not prove deep concentration. Gaze changes, looking down, and reading paper never automatically count as distraction.

To add a reflection, choose any answers and select **Save reflection**. Each answer can be skipped, edited, or cleared later. Flow means feeling absorbed and working smoothly; this short product question is not a validated psychological scale. Whole-session ratings are never assigned to individual minutes.

To tag part of a session:

1. Choose **Focused**, **Distracted**, or **Flow**, then enter elapsed start/end times as `HH:MM:SS`.
2. Check the visual preview and select **Add tag to list**. Use **Edit** or **Delete** to change existing entries.
3. Select **Save timeline tags** to persist the list. Up to 30 tags are supported per session.

Tags must stay within saved study time and cannot overlap each other, explicit breaks, or known diagnostic windows. They may cover unknown camera time; the observation layer stays unknown. Reflection and tag saves are separate from session saving. Failures keep your entries for retry without undoing the saved session. Closing or refreshing a report discards unsaved form/list changes.

The Analysis **Study patterns** section aggregates behavioral totals, tagged durations, average submitted ratings with response counts, and reported-flow session counts for the selected date range. Missing ratings remain N/A, never zero. There is no overall focus score.

Only these behavioral metrics exclude calibration and accuracy-check windows; existing daily study-time and presence totals retain their original definitions. Older sessions with uncertain diagnostic boundaries show why behavioral metrics are unavailable, while reflection remains available. See [definitions, API, migration, and limitations](docs/study-patterns.md).

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

Last verified for the study-pattern release: **88 Python tests and 51 frontend tests passed**, along with TypeScript checks and the production build through `make test`. Tests use synthetic observations and temporary databases; they do not activate the webcam.

Coverage includes:

- Session timing, presence rules, camera toggles, breaks, startup/retry failures, stale frames, worker crashes, and recovery without losing session identity or timeline coverage.
- Calibration, accuracy-check sampling, diagnostic lifecycle, reliability-trial timing, and persistence.
- Hash navigation, retained inputs/filters, reconnection, preview/calibration races, pointer and keyboard dragging, and focus restoration.
- Sustained-period boundaries, diagnostic exclusions, missing evidence, reflection/tag validation, retry-safe saves, database migration/rollback, and detailed-report/aggregate parity.

Separate Chrome integration checks against a real local API and a temporary database passed report save/retry/reopen flows, tag preservation over unknown observations, keyboard navigation, and layouts at 320, 375, 768, and 1440 pixels. Desktop/mobile Analysis and report screens passed automated axe WCAG 2 A/AA and 2.1 AA checks and visual inspection. These browser checks are separate from `make test`; see the [recorded verification](docs/study-patterns.md#verification-recorded-for-this-implementation).

Physical webcam validation remains separate. Camera startup, live preview, face detection, and head-angle readings have been exercised on the development Mac, but these do not establish screen-gaze accuracy. The required trials across multiple days and changes in lighting, glasses, seating, and head movement remain documented in the [gaze reliability checklist](docs/gaze-reliability.md).

## Local data

SQLite records are stored in `.data/sessions.sqlite3`. The face model is cached in `core/models/face_landmarker.task`. Both are ignored by Git. Raw frames stay in memory. While the preview is open, the latest JPEG is delivered over loopback to the local browser; no video is saved or uploaded to an external service.

Saved data includes session/presence timelines, compact gaze records, calibration parameters, diagnostics, optional reflection answers, and personal timeline tags. Full face meshes and individual identities are not stored. Diagnostic JSON downloads contain numerical results and metadata, without frames or model coefficients.

The current backend requires **API version 4** and upgrades earlier SQLite databases transactionally to **schema version 4**, preserving existing sessions and observations. Stop an older running backend before starting the updated app; the launcher will not reuse an incompatible API. Older sessions without gaze observations show **No gaze data recorded**. Sessions with unreliable historical diagnostic boundaries keep their original presence reports and personal reflections, while the new behavioral metrics explain their unavailability.

## Structure

```text
apps/
├── desktop/        # src/, components/, pages/, src-tauri/; local React UI and launcher
└── vision/         # Camera worker, face/eye features, gaze tracker, diagnostics, local API
core/
├── session.py      # Timer and serialized session/camera/calibration/diagnostic lifecycle
├── features/       # Image-free numerical observation contracts
├── behavior/       # Away rule; future classifiers
├── analytics/      # Presence totals and versioned study-pattern analysis
└── models/         # Downloaded model cache
database/           # SQLite store and transactional migrations through v4
extensions/         # Chrome and VS Code placeholders
tests/              # Synthetic observations and temporary databases
docs/               # Architecture, privacy, gaze reliability, and study-pattern definitions
```

The current desktop frontend runs locally in your browser. Tauri packaging, body/phone detection, and computer activity tracking remain outside this release. Automatic mental-state detection, face identity recognition, video recording, and cloud hosting are not implemented.

See [architecture](docs/architecture.md), [privacy](docs/privacy.md), and the [Apache 2.0 license](LICENSE).
