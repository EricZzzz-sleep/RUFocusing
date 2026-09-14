# Public website

The public app lives in `apps/web`. The local React/Python app, `make run`, and `.data/sessions.sqlite3` remain independent. Nothing imports or uploads local history. The public app reuses the local timeline and reflection components; the reflection component accepts an optional transport while retaining its original local default.

## Development

Requires the existing Node/Python prerequisites and Docker for the full local cloud stack.

```sh
npm --prefix apps/web ci
npm --prefix apps/web run models
npx --yes supabase@2.117.0 start
npm --prefix apps/web run local:configure
npx --yes supabase@2.117.0 functions serve api --env-file supabase/functions/.env.local
# In another terminal:
npm --prefix apps/web run dev
```

Create `supabase/functions/.env.local` from its `.env.example`; the default web origin is `http://127.0.0.1:5174`. The configure script reads only the disposable local Supabase stack and writes its public URL/anon key to an ignored `apps/web/.env.local`. Never use production credentials for tests. Local registration and password-reset emails appear in Mailpit at `http://127.0.0.1:54324`.

The dev/build scripts prepare a classic worker bundle because MediaPipe’s WASM loader uses `importScripts`. Run `npm --prefix apps/web run camera:build` after changing the worker during an existing dev session.

The model preparation script downloads the pinned Google float16 face model, verifies SHA-256, and copies the versioned MediaPipe WASM assets from the installed package. All inference assets are then served from the site's own origin. Frames and meshes remain in browser memory; only compact presence intervals are uploaded.

## Commands and data

The Edge Function validates each bearer token with `auth.getUser()`. Origin validation uses the exact `ALLOWED_ORIGINS` allowlist. A browser receives only a public Supabase key. The service-role key is used server-side only for deleting the authenticated account. Normal data access uses the user's identity and RLS.

The API base is `<SUPABASE_URL>/functions/v1/api`:

| Operation | Interface |
| --- | --- |
| Active session / expire abandoned recording | `GET /state` |
| Paginated history | `GET /history?days=7&search=&mode=&status=&page=0` |
| Aggregated overview and daily chart | `GET /overview?days=7` (`7`, `30`, or `0` for all time) |
| Session / reflection report | `GET /sessions/:id`, `GET /sessions/:id/analysis` |
| Preferences | `GET /settings`, `POST /settings` with `timezone`, `default_mode` |
| Session mutation | `POST /commands` with `action`, `command_id`, `tab_id`, optional `session_id` and `revision`, plus `data` |
| Paginated full export | `GET /export?before=<server timestamp>&after=<last UUID>` (100 records per page) |
| Delete own account | `POST /account/delete` with `confirm: "DELETE"` |

Command actions: `start`, `checkpoint`, `pause`, `resume`, `end`, `camera`, `edit`, `delete`, `reflection`, `annotations`. Command IDs identify retries; session revisions reject stale concurrent edits. Each browser document has a fresh tab ID, so reloads or copied tabs cannot silently take recording ownership. A transient pending command is retained in session storage to allow an exact retry; this is not authoritative session data.

All session mutations take a transaction-scoped account lock. A partial unique index enforces one running/paused session per user. Checkpoints arrive every five seconds; a recording lease expires after 30 seconds. Expiry is reconciled on the next state read or command and pauses at the last acknowledged checkpoint. Offline time becomes break time only when a later resume/end records the gap; it is never counted as study. Resume explicitly acquires a new recording lease. A closed tab requires no unreliable unload request or background scheduler.

Server time defines lifecycle boundaries. A browser clock approximation is used only for live preview. Presence evidence is clipped to the server checkpoint window; gaps are unknown and evidence is usable for at most two seconds. Hidden tabs produce unknown observations, and browser throttling can trigger the lease timeout. Camera initialization/inference failures preserve camera-free timer operation.

`supabase/functions/_shared/study.ts` is the canonical TypeScript report/detector implementation. `packages/study` reexports it for the browser. Reports normalize gaps and overlaps conservatively; fixtures generated from the existing Python implementation verify parity. SQL aggregation uses the same 600-second continuous-presence threshold, with parity checks against the shared report. History queries fetch one page; overview queries aggregate in Postgres.

Application tables have RLS and authenticated owner-only SELECT policies. Direct client writes and internal helper execution are revoked. The supported SECURITY DEFINER RPCs use an empty search path, derive ownership from `auth.uid()`, validate input, and serialize mutations. Composite foreign keys prevent linking another owner's intervals/reflections. Account deletion cascades all application data; session deletion preserves content-free command tombstones so delayed retries cannot recreate deleted data.

## Tests

```sh
.venv/bin/python -m unittest discover -s tests -v
npm --prefix apps/desktop test
npm --prefix apps/desktop run build
npm --prefix apps/web test
npm --prefix apps/web run build
# With the local stack, function server, and web dev server running:
npm --prefix apps/web exec playwright install chromium
npm --prefix apps/web run test:integration
npm --prefix apps/web run test:ui
```

Database tests execute the actual migration in embedded PostgreSQL (PGlite) with test-only auth identities and roles. Browser tests use the real local Supabase Auth, Postgres, and Edge Function, create disposable users, and delete them afterward. They refuse any non-local backend. Screenshots and traces are ignored artifacts. Google OAuth and real webcam accuracy require separate production/provider and physical-device acceptance; passing synthetic tests does not establish those.

## Production setup and launch

The Sites project is registered in `apps/web/.openai/hosting.json`; registration does not publish the website. Its reserved URL is `https://rufocusing.neon-morel-6381.chatgpt.site`. Do not create another Sites project.

1. Create a Supabase project. Link the CLI to its project reference, review `supabase/migrations`, then run `supabase db push`. Cloud history starts empty.
2. Set Supabase Auth's site URL to the public website origin. Allow exactly `/auth/callback` and `/auth/reset` on that origin as redirect URLs. Enable email verification and a minimum password length of 10 characters.
3. Configure a production SMTP sender in Supabase Auth. Verify signup confirmation, resend, and reset delivery. Local Mailpit is for development only.
4. Configure Google OAuth with the site's origin and Supabase's callback URI. Enable the Google provider in Supabase. Keep the Google client secret out of all browser files.
5. Set the function secret `ALLOWED_ORIGINS` to the public site origin, then deploy the `api` function. Supabase supplies its internal URL, anon key, and service-role key. Never expose the service-role key to Sites or Vite.
6. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` for the production build (an ignored `.env.production.local` or explicit build environment). Run `npm --prefix apps/web run build:release`. This rejects a missing/non-HTTPS/local backend or a privileged browser key and prepares model assets.
7. Complete the acceptance checks below, then use the existing Sites project to publish the validated `apps/web/dist` static output. Push the corresponding source, retaining shared source dependencies; package with the Sites `package-site.sh` helper against `apps/web`. The archive must contain only public build assets, never `.env` files or the local SQLite database. Explicitly change the site audience to public as requested only at launch.

Launch acceptance: Google and verified-email sign-in; email recovery; cross-account isolation; camera-free record/save/reload on another device; pause/resume and competing tabs; lost response retry; 30-second timeout; report/filter/export/deletion; desktop/mobile keyboard and overflow checks; real-camera permission/retry and a ten-minute physical presence session. Verify static navigation to `/analysis`, `/record`, `/sessions/:id`, `/settings`, and auth callback routes on the hosted URL.

Observe Edge Function request IDs, HTTP statuses, and error codes for failed saves. Never log tokens, emails, task names, reflections, images, or face landmarks. Roll back frontend/function versions if needed; database migrations are append-only. Keep production backups under the provider's configured retention policy, and describe that retention accurately before making deletion guarantees beyond live application data.

This v1 does not add gaze calibration, local-history import, Pomodoro scheduling, goals, social features, payments, or offline recording.

## Latest local validation

- Existing app: 100 Python tests, 64 frontend tests, and production build pass.
- Public app: 26 unit/database/parity tests, 3 real local API integration tests, and 13 desktop/mobile browser scenarios pass; the desktop-only synthetic camera scenario is intentionally skipped in the mobile project.
- Browser checks include actual local email verification/reset, record/break/resume/save, reflection/edit/export/delete, account deletion, conflicting tabs, lost-response retries, camera permission denial, and the classic MediaPipe worker processing synthetic video and releasing capture.
- The release configuration check correctly rejects the local Supabase backend. No public deployment has been made. Production Google OAuth, external email delivery, hosted route behavior, and physical-webcam accuracy remain launch acceptance requirements.
- Optional WebMCP tools passed a registry contract test. A live browser WebMCP implementation was not available for platform-level validation.

Cloudflare-compatible `_redirects` map the app and callback routes to the SPA entry point while leaving static model/worker assets untouched. See the [Cloudflare static asset proxying contract](https://developers.cloudflare.com/workers/static-assets/redirects/#proxying).
