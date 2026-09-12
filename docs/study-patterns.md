# Study patterns and personal reflection

This release analyzes **saved** sessions from numerical presence timelines. “Deep study” means sustained concentration, not neural-network training. There are no automatic mental-state labels, overall focus scores, live alerts, app/site monitoring, new models, or video recordings.

## Using the reports

On **Analysis**, choose Last 7 days (the default), Last 30 days, or All time. **Study patterns** uses the same saved-session date selection as the daily chart. Session history search, mode, and completion filters affect only the history list. Completed and interrupted sessions count; grouping uses the browser's local start date, including today.

Save a session or open one from history. Its report starts with separate cards for observed sustained at-desk periods, possible interruptions, presence coverage, and personal ratings. Existing session timing, presence totals, gaze context, and diagnostic results remain available below.

The optional reflection asks for concentration (1 = very low, 5 = very high), distraction frequency (1 = rarely, 5 = very often), and **Self-reported flow** (Yes / No / Unsure). Flow means feeling absorbed and working smoothly. This short product question is not a validated psychological scale. The [background flow study](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2023.1187153/full) uses recalled experience; our reports likewise keep reported experience distinct from camera observations.

Each answer can be skipped or cleared with “Skipped / clear answer,” then **Save reflection**. Reflection saves independently of the study session. A failed save keeps the entered values for retry and cannot undo the saved session.

Optional **Focused**, **Distracted**, and **Flow** timeline tags use elapsed `HH:MM:SS` start/end inputs. Preview the interval, **Add tag to list**, then **Save timeline tags**. Edit or delete entries and save the replacement list to persist changes. Up to 30 tags are supported per session under the existing bounded request size. Tags may cover unknown camera time; the observation layer stays unknown. They cannot overlap each other, explicit breaks, or known diagnostic windows. Adjacent tags are allowed. Cancel an unfinished edit before saving the list. Unsaved form/list edits are kept while this report is open; closing or refreshing discards those drafts.

## Definitions: study-patterns-v1

| Indicator | Definition and evidence |
| --- | --- |
| Sustained at-desk periods | Continuous recorded `present` intervals lasting **at least 600 seconds**. Count, full duration, and longest qualifying period are reported. Unknown, away, break, missing timeline gaps, and diagnostic windows split continuity. |
| Possible interruptions | Each recorded away interval outside breaks/diagnostics, with timing and duration. The initial unknown absence interval is never backfilled; no cause is inferred. |
| Behavioral observation coverage | `(present + away) / eligible study time`, after excluding explicit breaks and calibration/accuracy-check windows. Unknown eligible time stays in the denominator; zero denominator is N/A. |
| Self-reported tagged durations | Time explicitly labeled by the user, summed independently for Focused, Distracted, and Flow. |
| Self-reported sustained focus | Individual Focused or Flow tags lasting at least 600 seconds. Adjacent short tags are not joined to qualify. Distracted tags never qualify. |
| Average submitted ratings | Arithmetic mean of non-null whole-session answers, shown with response counts. Missing responses are N/A, never zero. |
| Self-reported flow sessions | Counts of submitted Yes, No, and Unsure answers, separate from Flow-tag duration. |

Ten minutes is a versioned **product default**, not a scientifically validated concentration threshold. At-desk evidence may support sustained study but cannot establish deep concentration. Gaze regions, gaze stability, center gaze, looking down, or reading paper do not label focus, distraction, or flow. Camera failures, uncalibrated/outside-display gaze, and missing observations remain unknown in their respective observation layers.

Only the new behavioral indicators exclude diagnostics. Existing elapsed time, presence totals, daily study time (`elapsed - breaks`), gaze coverage, and trial-time definitions are unchanged. Report cards explicitly label the distinct coverage denominator. Aggregates use summed observed/eligible durations, including timer-only eligible time; sessions with unreliable exclusion provenance do not contribute either duration. Behavioral counts/totals display N/A when no session has usable presence evidence. Personal ratings/tags still aggregate for those sessions. Session-wide ratings are never assigned to individual minutes.

## API and persistence

API health and launcher compatibility require **version 4**. Existing loopback/origin checks, `X-RUFocusing: 1`, JSON-object requests, the 4 KiB body limit, and controller serialization apply.

- `GET /api/sessions/{id}/analysis`: detailed, versioned summary, availability/reasons, derived evidence intervals, sustained periods, away episodes, exact diagnostic exclusions, reflection, and tags.
- `POST /api/sessions/{id}/reflection`: replace with `{ "concentration": 1..5 | null, "distraction": 1..5 | null, "flow": "yes" | "no" | "unsure" | null }`. Omitted reflection fields clear their answers.
- `POST /api/sessions/{id}/annotations`: replace with `{ "annotations": [{ "start": seconds, "end": seconds, "kind": "focused" | "distracted" | "flow" }] }`; an empty list clears all tags.

All three require a completed or interrupted session. POSTs return the complete analysis; identical retries are harmless. Saved sessions in `/api/state` include compact `analysis_summary` data. Detailed report intervals are fetched when the report opens. The dashboard refreshes its summary through existing polling, without resetting form drafts.

SQLite upgrades transactionally through all prior versions to **v4**, adding `analysis_provenance`, `session_reflections`, `session_annotations`, and `diagnostic_exclusions`. Recorded presence and gaze rows are preserved. Exclusions capture whole calibration/check windows, including settling, waiting for targets, completion, cancellation, failure, owner loss, and interruption, in session-elapsed coordinates. Trials themselves are not diagnostic exclusions. Setup diagnostics that finish before a session do not exclude session time.

Boundaries are captured at controller transitions, persisted with diagnostic checkpoints and immediately for commands; pending boundaries survive write failures. An open exclusion after a restart closes at the last persisted session checkpoint. Sessions already active at upgrade are marked as having incomplete provenance and are recovered as interrupted. Historical sessions without diagnostic/calibration records can use existing timelines. Older sessions linked to diagnostics or calibrations conservatively report `historical_diagnostic_boundaries_missing`; wall-clock and monotonic timestamps are not guessed into session-relative boundaries. This can also affect older setup calibrations whose before-session timing cannot be established. Reflection and tags remain available, with only known exclusion windows enforceable.

## Validation and limits

`make test` covers ten-minute boundaries, adjacent and split presence, away episodes, unknown gaps, diagnostic subtraction, zero/timer-only/interrupted sessions, non-inference from gaze, optional/cleared answers, tag validation, replacement retries, rollback, historical availability, checkpoint recovery, command security, saved-only editing, form failures, focus restoration, and aggregate/date-filter parity.

Browser integration uses a temporary database with sustained work, frequent departures, paper reading, missing camera data, and older calibration examples. It checks actual API persistence, report reopening, separate tag/observation layers, simulated save failure recovery, keyboard operation, and desktop/mobile overflow and WCAG accessibility checks. These synthetic examples verify report semantics, not concentration or physical webcam accuracy.

The separate [physical gaze reliability milestone](gaze-reliability.md) remains open. This release adds no physical validation or evidence of mental-state detection.

### Verification recorded for this implementation

- `make test`: **88 Python tests and 51 frontend tests passed**, including TypeScript checking and the production build.
- Chrome integration against a real local API and a temporary database passed save/retry/reopen flows, tag preservation over unknown observations, dashboard/detail parity, report focus return, keyboard form navigation, and new-session save-to-report navigation.
- Desktop (1440 px) and mobile (375 px) Analysis/report screens, including expanded evidence tables, passed axe WCAG 2 A/AA and 2.1 AA checks with no violations. Overflow checks passed at 320, 375, 768, and 1440 px. Screens were visually inspected.
- The existing local database upgraded to v4 with all five saved sessions and original timeline/summary fields preserved. The running local API was restarted with the camera off and no active session.
- All example observations were synthetic. No physical-webcam accuracy or mental-state validation is claimed.
