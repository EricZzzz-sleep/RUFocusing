# Privacy

Phase 1 runs locally and requires no account.

- The camera is off by default. It starts when the user explicitly enables webcam observations/opens a setup preview, or starts a webcam-enabled session.
- Camera frames and complete landmarks are not written to SQLite or uploaded to external services. While the preview is open, the latest JPEG is sent over loopback to the local browser for framing; it stays in memory and is not cached. Mirror mode changes only the displayed preview.
- The app saves task/mode, timestamps, presence intervals, camera availability, face counts, and approximate head angles in `.data/sessions.sqlite3`.
- Closing a setup preview stops its camera; abandoned setup previews expire after eight seconds without frame requests. No session or observations are saved during setup. Closing the preview during an active session leaves tracking on.
- Breaks, session end, and normal application shutdown stop the camera process. Capture continues if only the browser tab closes; the session remains active until ended or the local server is stopped.
- Camera permission failures and stale observations become unknown; the timer remains usable.
- No microphone capture, keystroke collection, browsing history, screenshots, or telemetry is implemented.
- First-time dependency/model setup uses the network. The pinned model is cached for offline sessions. Session data is not sent to that download service.
- Local SQLite is not encrypted by the app. The database and model cache are ignored by Git.

Session export and deletion controls are not implemented in Phase 1. To remove all stored sessions, first stop `make run`, then remove `.data/sessions.sqlite3` (this permanently deletes the history).
