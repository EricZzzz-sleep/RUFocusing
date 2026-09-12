# Experimental screen gaze tracking

RUFocusing estimates a gaze point on **one calibrated display**. It detects faces and eye landmarks; it does not recognize people or measure mental concentration. The existing at-desk/away presence timeline stays independent.

## Use

1. Restart an older running app with Ctrl+C in its launching terminal, then `make run`. The launcher checks API version 3 and will not reuse an older backend. The SQLite migration preserves existing sessions; older app versions cannot reopen the upgraded database.
2. Open the **Record** tab, enable webcam observations, and check camera framing. In **Screen gaze**, select **Calibrate gaze**. Calibration uses fullscreen and requires a desktop browser that supports it.
3. Look at each target while keeping your head comfortably still and both eyes visible. There are nine training targets and four separate accuracy checks. Each target discards the first 500 ms and requires at least ten unique usable frames spanning two seconds. A target times out after ten seconds and can be retried.
4. After successful validation, the small display map shows the estimated point. It is normalized to the calibrated display, not to the study webpage's current window. Gaze coverage and region durations appear in saved reports.
5. Recalibrate when asked, or manually after moving to another monitor, moving the camera, changing zoom/display configuration, or changing seating position. This version supports one fixed display; matching-resolution monitors cannot always be distinguished by browser geometry alone.

Escape, Cancel calibration, leaving fullscreen, switching to Analysis, or hiding the calibration browser tab cancels collection. Backend collection expires after three seconds without the owning calibration's heartbeat. Ordinary state polling cannot keep abandoned collection alive.

Calibration can transfer from an open setup preview into the immediately following session. Closing or abandoning setup clears it. New sessions require new calibration. Routine breaks and observation toggles retain validated calibration; camera failure/retry, camera index/resolution changes, display geometry changes, and sustained seating changes invalidate it. Camera-off time and breaks never show a point.

## Model and quality gates

The pinned [MediaPipe Face Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/python) supplies face/iris landmarks and a head transformation matrix. [Iris landmarks do not themselves provide gaze coordinates](https://research.google/blog/mediapipe-iris-real-time-iris-tracking-depth-estimation/).

`iris-ridge-v1` uses nine features: horizontal and vertical iris position relative to each eye's pixel-space axes, pitch, yaw, face center x/y, and face width. Pixel-space axes account for image aspect ratio. Preview mirroring never changes these inputs. Standardized features are fitted with NumPy ridge regression (lambda 1, unpenalized intercept).

Training targets use the Cartesian product of 10%, 50%, and 90% display coordinates. Held-out validation uses 30% and 70%. Validation frames are never used for fitting. Error is Euclidean pixel distance divided by display diagonal. Acceptance requires median error ≤10% and p90 error ≤20%. Failed calibration has no prediction model. These are proposed release gates, not promised accuracy or a calibrated probability of correctness.

Versioned quality heuristics reject clipped faces, face widths below 12% of the frame, eye widths below eight pixels, eye openness below 0.12 eye widths, invalid or inconsistent eye geometry, and absolute pitch/yaw/roll above 40 degrees. These geometric checks cannot detect every occlusion or landmark error.

Relative to calibration, face-center displacement above 10% of a frame dimension, scale outside 0.75–1.25, or pitch/yaw outside the training range plus ten degrees immediately hides the point. Sustained departure for two seconds invalidates calibration. Invalid frames, blinks, multiple faces, and estimates outside [0,1] clear the point and smoothing. Outside estimates are not clamped to screen edges and do not prove that a person is looking away.

Valid points use a 250 ms time-constant exponential smoother. Observations older than 750 ms are unavailable, independently of the existing two-second camera freshness threshold. The frontend also hides points when its live response is stale or slow. Live gaze sampling targets approximately five frames/second; checkpoints remain approximately one second. Gaze intervals use one checkpoint timestamp, apply valid changes prospectively, and mark missing evidence/scheduling gaps unknown.

## API and persistence

- `GET /api/gaze/state` returns quality, a nullable estimated point, and calibration progress. During collection the owning page sends `?calibration_id=…` as a heartbeat.
- `POST /api/gaze/calibration/start`: `{ "display": { "width": 1440, "height": 900, "device_pixel_ratio": 2 } }`. The camera must already be enabled and ready.
- `POST /api/gaze/calibration/target`: `{ "calibration_id": "…", "target_index": 0 }`. Targets must be collected in order. Duplicate starts of the running target do not restart it.
- `POST /api/gaze/calibration/complete`: `{ "calibration_id": "…" }`. All thirteen targets must have valid samples.
- `POST /api/gaze/calibration/reset`: `{ "calibration_id": "…" }` cancels/clears the current calibration; an old identifier cannot clear a newer one.
- `POST /api/gaze/calibration/display`: `{ "display": { … } }` invalidates calibration when display geometry differs. This additional endpoint supports window/display-change checks.
- `GET /api/sessions/{id}/gaze` returns gaze intervals, summary, and validation metadata for accepted calibrations. Model coefficients are not sent to the frontend.

All POSTs retain JSON, `X-RUFocusing: 1`, loopback/origin checks, and the 4 KiB request limit. Camera/session commands share the controller lock with calibration commands.

Schema version 2 introduced separate `calibrations`, `gaze_observations`, and `gaze_intervals` tables through a transactional migration. Accepted model parameters/version/display geometry/error statistics and compact point observations are stored locally. Raw training samples are discarded after fitting/validation. Full meshes, images, and video are never saved. Old sessions have no gaze summary; new timer-only sessions have unknown gaze time. Gaze coverage is valid gaze duration divided by study duration, excluding breaks, with N/A for zero study duration.

## Validation record and physical acceptance

Automated tests cover geometry/aspect ratio, rejected frames, target timing/duplicates, calibration fitting, held-out failure, smoothing, stale points, seating invalidation, controller lifecycle, real-clock interval continuity, transactional migration rollback, API validation, and frontend completion/cancellation/error behavior.

The real pinned MediaPipe model has also been exercised on a blank frame (zero faces) and the public `business-person.png` sample from [Google's example notebook](https://github.com/google-ai-edge/mediapipe-samples/tree/main/examples/face_landmarker/python) (one face, finite pose, usable compact eye features). This checks model integration, not physical gaze accuracy or consented user validation.

Browser integration uses a temporary database and synthetic features at a real five-Hz cadence to exercise all thirteen targets, report rendering, breaks, toggles, reload recovery, and interval accounting. Synthetic error values must not be cited as webcam accuracy.

Desktop and mobile layouts are checked for overflow at 320, 375, 768, and 1440 pixels. Automated accessibility checks cover the dashboard, fullscreen calibration, and saved report; keyboard checks cover calibration focus containment, Escape cancellation, and focus restoration.

**Physical accuracy remains unverified; the feature stays experimental.** A person must perform the following walkthrough before making a readiness claim:

| Condition | Record |
| --- | --- |
| Normal lighting and comfortable seating | Median/p90 error from the four held-out targets; tracked-time coverage |
| Dimmer lighting and side lighting | Same errors/coverage; observe rejected landmarks |
| Glasses, if worn | Same errors/coverage, especially with reflections |
| Nearer/farther seating and moderate head movement | Point suppression and recalibration behavior |
| Blinks, leaving frame, another face | Immediate point hiding; no stale-point carryover |
| Break/resume and camera toggle | Preserved session time; no gaze during breaks/off periods |
| Camera retry/display changes | Recalibration required; earlier intervals preserved |

Use only participating users who agree to the test. Do not treat a single passing calibration as proof of performance across lighting, eyewear, or users. Record failures as well as passes and keep estimates suppressed when validation fails.

The schema now upgrades to version 3 for independent accuracy checks, trial durations, and failed/cancelled calibration attempts. See [gaze reliability diagnostics and physical acceptance](gaze-reliability.md).
