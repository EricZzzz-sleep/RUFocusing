# Experimental gaze reliability checks

The checks measure the existing gaze estimator. They do not fit a model, recognize a person, or measure concentration. Physical performance on your webcam is still unverified.

## Run an accuracy check

1. Open **Record**. Enable webcam observations and complete **Calibrate gaze** on your display.
2. In **Gaze reliability**, select lighting, glasses, seating distance, and optional notes. Select **Check gaze accuracy**.
3. Follow each of nine targets. The server shuffles the combinations of 20%, 50%, and 80% coordinates for each attempt. The estimated point is hidden while collecting.
4. Each target settles for 500 ms, then measures exactly three seconds. Blinks, missing frames, and bad geometry do not extend the window. A normal check takes about 32 seconds plus request/rendering time.
5. Open the new entry under **Recent diagnostics** to inspect errors, coverage, per-target results, and unavailable reasons. **Download JSON** saves an inspectable local copy. Retry a check with the button; earlier attempts remain recorded.

A complete target needs ten distinct valid observations spanning at least two seconds. All nine targets must be complete for the check to pass or fail the error gates. Otherwise the result is **Incomplete**; it cannot establish accuracy. Error uses valid production predictions only, including smoothing, and is pixel distance divided by the display diagonal. No unavailable or outside-display estimate is clamped or assigned an error coordinate.

A complete check passes with median error at most 10% and p90 at most 20% of the display diagonal. A failed check clears calibration and suppresses later estimates until recalibration. An incomplete check preserves accepted calibration unless another invalidation rule applies. Coverage is shown alongside error and has **no pass/fail threshold**.

Escape, Cancel, leaving fullscreen, hiding the browser tab, or switching to Analysis cancels a check. A disconnected owner expires after three seconds; refreshing cannot adopt its collection. Completed targets and partial target aggregates are retained. Ordinary polling does not keep an abandoned check alive.

## Run a 25-minute study trial

Start a study session with accepted calibration, then select **Start reliability trial**. An initial accuracy check opens; the trial's ordinary-study clock begins only if that check passes.

The app offers nonblocking reminders at approximately 10 and 25 minutes of ordinary study time. Use **Run due check** when ready; fullscreen never opens automatically. You may dismiss a reminder and run a check later with **Check gaze accuracy**. Actual checkpoint times are retained. The trial completes after a final completed/incomplete check at or after 25 minutes. Stopping early or skipping a checkpoint is recorded rather than reported as success.

- Breaks and diagnostic collection windows are excluded from trial study time and coverage. Ordinary session timing, study metrics, and presence intervals retain their existing definitions. Reports identify check windows separately.
- Camera-off and unavailable study time stay in the trial coverage denominator. Long missing-observation gaps become unknown; valid evidence never extends beyond its 750 ms freshness lifetime.
- Reports include unavailable durations by reason and coverage in successive five-minute study periods. Coverage with no measured study time is N/A.
- Breaks, normal camera toggles, Analysis navigation, and reconnection preserve the trial. Calibration replacement/invalidation, camera retry, and session termination interrupt it and retain the reason.
- **Stop trial** does not stop the study session. End and save the session normally. Its report on Analysis links the diagnostics.

Trial status **Completed** means the protocol reached its final check. Inspect each checkpoint's result: this is not itself a claim that all accuracy gates passed.

## Local records and API

`gaze-reliability-v1` records compact numerical summaries, target order/results, rejection counts, durations, condition notes, timestamps, display/camera configuration, calibration identifiers, and model/protocol versions. Calibration attempts include failed and cancelled attempts. Full frames, video, full landmarks, and training features are not stored in diagnostics. Public results and JSON downloads do not contain model coefficients.

SQLite schema version 3 adds `diagnostic_runs`, `diagnostic_targets`, and `diagnostic_durations`. Migration from versions 0/1/2 is transactional. Saved sessions and presence/gaze records are preserved. Unfinished diagnostics reopen as interrupted at their saved checkpoint. Existing sessions without diagnostics show an empty state. Restart an older backend before using this frontend; the launcher now requires API version 4 for the additional [study-pattern reports](study-patterns.md).

Public interfaces retain loopback/origin restrictions, the `X-RUFocusing: 1` header, JSON validation, the 4 KiB POST limit, and the shared session command lock:

- `GET /api/gaze/diagnostics/state`: active check/trial and ten recent summaries. Only the owning page sends `?check_id=…` to renew collection.
- `GET /api/gaze/diagnostics`: the latest 50 runs; optional `?session_id=…` filters to a session.
- `GET /api/gaze/diagnostics/{id}`: full numerical results for display/export.
- `POST /api/gaze/checks/start`: `{ "request_id": "unique-client-id", "display": { "width": 1440, "height": 900, "device_pixel_ratio": 2 }, "conditions": { "lighting": "normal", "glasses": "none", "distance": "normal", "notes": "" } }`. Display must match accepted calibration. Conditions may be omitted.
- `POST /api/gaze/checks/target`: `{ "id": "check-id", "target_index": 0 }`. Acknowledge the painted target before collection. Coordinates and samples come from the server.
- `POST /api/gaze/checks/complete` or `/cancel`: `{ "id": "check-id" }`.
- `POST /api/gaze/trials/start`: the same display/conditions/request-id fields; requires an active calibrated session.
- `POST /api/gaze/trials/stop`: `{ "id": "trial-id" }`.
- `POST /api/gaze/trials/reminder`: `{ "id": "trial-id", "checkpoint": "mid" }` dismisses an initial/mid/final reminder without ending the trial.

A request ID makes retried starts harmless during the current application run. Checks cannot overlap calibration or another check. Invalid identifiers never cancel a newer run.

## Validation record

Automated checks use synthetic features and temporary databases. They cover fixed-window sampling, settling, duplicate frames, production-model separation, incomplete/failed outcomes, coverage accounting, break/camera lifecycle, suspension gaps, checkpoint failures, migrations and rollback, API restrictions, frontend request races, reminders, cancellation, and result rendering.

The browser walkthrough uses the actual API and production estimator with a synthetic camera at five Hz. It covers calibration followed by nine independent accuracy targets, result inspection/download, initial-trial cancellation, mobile layouts, accessible dialogs/tables, and saved-session result links. These results verify integration, **not webcam accuracy**. No estimator thresholds were tuned from these synthetic results.

## Physical acceptance record — pending

Run three fresh-calibration trials across at least two days on your webcam/display. Keep every attempt, including failures and incomplete checks. Record the diagnostic identifiers or exported JSON filenames below. A trial used for acceptance needs complete, passing checks at the start, around 10 minutes, and the end. Coverage is measured as a baseline only.

| Trial | Date / conditions | Calibration ID | Initial / mid / final check IDs | Median / p90 at each check | Trial coverage | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Not run | — | — | — | — | Pending |
| 2 | Not run | — | — | — | — | Pending |
| 3 | Not run | — | — | — | — | Pending |

Separately check dim/side lighting, glasses if worn, nearer/farther seating, moderate head movement, blinks, leaving frame, a second face, and camera retry. Verify immediate point suppression and appropriate recovery/recalibration while the session continues. Record failed or unavailable conditions without substituting synthetic measurements.

Only tune an estimator or quality heuristic when measured physical evidence supports the change. Give changes a new model/heuristic version, retain the accuracy gates, and repeat all three acceptance trials after the final tuning. Until those trials are complete and passing, the physical-reliability milestone remains open and the feature remains experimental.
