# Architecture

The project is organized as a local-first modular application. The directories below are scaffolding for future implementation.

| Directory | Intended responsibility |
| --- | --- |
| `apps/desktop/src` | Frontend entry point and application wiring |
| `apps/desktop/components` | Reusable interface components |
| `apps/desktop/pages` | Study-session history, summaries, and analysis screens |
| `apps/desktop/src-tauri` | Native desktop shell and local process integration |
| `apps/vision` | Camera capture, face/gaze/pose observations, optional phone detection, and worker entry point |
| `core/features` | Aggregate observations into time windows |
| `core/behavior` | Interpret observations using task context and rules; later classifiers |
| `core/analytics` | Summarize focus blocks, interruptions, and patterns across sessions |
| `core/models` | Future model assets |
| `extensions` | Optional Chrome and VS Code integrations |
| `database` | Local SQLite schema and migrations |
| `tests` | Future automated tests |

Intended data flow: observations → features → behavior estimates → session summaries → desktop analysis.

The desktop presents conclusions about completed study periods. Sensors provide observations; missing evidence stays unknown. Process communication and database integration will be defined when those modules are implemented.
