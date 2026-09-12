# Phase 1 architecture

`make run` supervises a Vite/React frontend and a loopback Python API. The API owns the session timer and SQLite writes. Camera capture and MediaPipe run in a separate, supervised Python process so native vision failures cannot stop the timer.

```text
Webcam → MediaPipe face landmarks → approximate head pose
                 ↓
        image-free observations → away rules
                                      ↓
React controls ↔ local Python API → SQLite → timeline and report
```

## Modules

- `apps/desktop/src`, `components`, and `pages`: frontend wiring, reusable timeline/report, and session page.
- `apps/desktop/components/CameraPreview.tsx`: a floating live preview with mirror/retry controls. It polls the most recent JPEG at up to 5 FPS and releases image URLs when closed.
- `apps/desktop/run.py`: service readiness checks, browser opening, port-conflict reporting, and process cleanup.
- `apps/vision/camera.py`: optional capture, one shared-memory frame slot, and camera-process lifecycle; target 5 inference frames/second.
- `apps/vision/face.py`: local MediaPipe Face Landmarker and checksum-verified model setup.
- `apps/vision/pose.py`: approximate pitch/yaw/roll from the facial transformation matrix. Feeds a separate calibrated gaze estimator; no mental-focus inference.
- `apps/vision/worker.py`: HTTP API on `127.0.0.1:18765`; React reaches it through Vite's `/api` proxy.
- `core/session.py`: one active session, a monotonic clock, explicit breaks, one-second observation persistence, and checkpoints.
- `core/behavior/rules.py`: one face → present; fresh no-face observations sustained for 10 seconds → estimated away; missing/stale/multiple-face evidence → unknown.
- `core/analytics/focus_blocks.py`: duration totals and longest continuous presence block.
- `database/store.py` and `schema.sql`: serialized SQLite access, schema version 4, persisted sessions, half-open timeline intervals, and compact observations.

The timeline covers elapsed session time exactly once, including explicit breaks and unknown gaps. Presence changes apply prospectively at the next observation update. An unavailable camera conservatively marks the interval since the previous update unknown. A scheduling/suspend gap longer than three seconds becomes unknown unless an explicit break is active. A crash is recovered at the last saved checkpoint; offline time is not invented as activity.

## API

| Request | Behavior |
| --- | --- |
| `GET /api/health` | Service readiness |
| `GET /api/state` | Active session, observation status, and saved session history |
| `POST /api/camera/preview/start` | Open setup preview without creating a session, or reopen/retry the active camera |
| `GET /api/camera/preview` | Latest in-memory JPEG; `204` when unavailable; requires `X-RUFocusing: 1` |
| `POST /api/camera/preview/stop` | Close setup preview and stop the camera, or hide preview while active tracking continues |
| `POST /api/sessions/start` | Start with `{ "task": "Assignment", "mode": "Math", "camera": false }` |
| `POST /api/sessions/camera` | Set `{ "enabled": true/false }` on the active session without resetting its timer; during breaks, apply on resume |
| `POST /api/sessions/pause` | Begin an explicit break and release the camera |
| `POST /api/sessions/resume` | Resume; restart the camera if enabled |
| `POST /api/sessions/end` | Save and return the completed report |

Changing the active camera setting advances the timeline under the session lock before persisting the setting in the existing `camera_enabled` column. A changed setting resets absence detection; disabled running intervals are unknown. Repeating a setting is a no-op for camera lifecycle. Breaks keep the camera released regardless of the saved setting. Saved sessions expose the final setting; presence reports derive from the timeline, not this flag. No schema migration is needed.

State responses include `observation.camera_status`, typed as `off | starting | ready | unavailable` in Python and TypeScript. It is runtime metadata, not a new SQLite column. `ready` means fresh frames and successful face inference, regardless of face count; the separate presence rules determine `present`, `away`, or `unknown`.

Startup is bounded to 15 seconds, after which the worker is released and retry becomes available. Frames older than two seconds are discarded and observations become unavailable. A worker exit and process-start errors produce actionable unavailable messages. The controller reuses a starting/ready setup camera when starting a session and ignores retries while initialization is underway. Retry resets the absence detector without resetting the session or rewriting its timeline. The frontend queues a close request made while preview startup is pending so closing cannot leave a setup camera behind.

POST requests use JSON, `X-RUFocusing: 1`, and a 4 KiB body limit. The API validates loopback hosts and the configured frontend origin; it grants no cross-origin access. Invalid tasks, modes, and lifecycle transitions return errors. Preview responses disable caching and cross-origin embedding. No frame-upload or recording endpoint exists.

The camera stores only the latest observation and preview JPEG in a 4 MiB shared-memory slot. Both reader and writer acquire its lock without blocking; a worker dying while holding the lock cannot stall the timer. A one-way pipe signals shutdown without a shared Event lock, and process joins are bounded before termination. Retry allocates fresh IPC resources. This avoids the shutdown deadlocks possible with [terminated workers holding multiprocessing queues or semaphores](https://docs.python.org/3/library/multiprocessing.html#multiprocessing.Process.terminate).

Setup previews create no session or database observations; they expire after eight seconds without a frame request. Starting a webcam session reuses a healthy setup camera. Breaks and session end release it and discard the cached preview.

## Model and limitations

[MediaPipe Face Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/python) supplies landmarks and facial transformation matrices. The model bundle is Google's float16 version 1; its source URL and SHA-256 are pinned in `face.py`. MediaPipe 0.10.32 is pinned because it passed native inference on the development Mac; 1.0.1 crashed during graph initialization there.

Head angles are approximate Euler rotations in the model coordinate system, without personal calibration. Low light or occlusion can prevent detection and resemble absence. The app labels away as estimated and never treats head orientation or face presence as proof of focus. Models and dependencies retain their own licenses; the repository license covers this project's code.

Tauri, extensions, richer features, and learned classifiers are still placeholders.

## Frontend analysis

The React dashboard derives reports from the saved history in `GET /api/state`. Date ranges use browser-local calendar boundaries, including today, and attribute sessions to their start date. The daily stacked bar chart fills missing dates with zeros and has an equivalent table. Its scale starts at zero; bars show present, away, and unknown durations with breaks excluded. Overview coverage divides summed observed time by summed study time. Task/mode/status filters affect only the history list, while date range affects the whole saved-session overview.

The backend remains authoritative for active session time and camera settings. Polling ignores responses that predate a user command, and command progress labels identify the operation underway. Connection loss shows the last received timer value with a reconnecting notice. The frontend never extrapolates a successful save after a failed request.

## Experimental gaze backend

See [gaze tracking](gaze-tracking.md) for the complete calibration protocol, quality thresholds, APIs, storage, and acceptance checks. The camera worker extracts compact eye features, and the parent session controller owns a separate `GazeTracker`. It samples distinct frames at approximately 5 Hz without making history/database writes at that rate. Gaze intervals are accumulated between approximately one-second checkpoints and committed with session observations. Invalid data and gaps remain unknown. Physical accuracy is unverified.

API health includes `api_version: 4`; the launcher rejects older running services. Version-1 databases migrate transactionally to separate calibration/gaze tables, without altering their existing presence records.

## Gaze reliability diagnostics

The parent-owned diagnostic collector consumes the existing five-Hz gaze estimator output without training it. Fixed-window checks, calibration-attempt records, and 25-minute trials share the session command lock and approximately one-second persistence cadence. SQLite v3 adds separate diagnostic runs, target results, and duration summaries. See [protocol, APIs, lifecycle, and acceptance](gaze-reliability.md).


## Saved study-pattern reports (API and schema v4)

The pure `core/analytics/study_patterns.py` analysis uses saved presence timelines and exact session-relative diagnostic exclusions. Reflection and annotation tables store optional personal experience separately; they never rewrite presence or gaze observations. The controller serializes replacement saves and captures exclusion boundaries during diagnostic lifecycle changes. Migration preserves prior data and marks older uncertain boundaries unavailable. See [study-pattern definitions and migration behavior](study-patterns.md).

Personal ratings and timeline tags stay in the same local SQLite database as session history. No additional frames, meshes, identities, app/site activity, or model inputs are collected for these reports.
