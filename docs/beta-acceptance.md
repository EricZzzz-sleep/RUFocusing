# Private beta acceptance

The beta uses the existing owner-only Sites project in `apps/web/.openai/hosting.json`. Production history is independent of the desktop app and the disposable local Supabase database. Do not publish a build using the local backend or advertise the beta as ready before hosted acceptance passes.

## Repeatable local checks

Start the local Supabase stack, API function, and web server using [public-web.md](public-web.md). Install browser engines once:

```sh
npm --prefix apps/web exec playwright install chromium firefox webkit
npm --prefix apps/web run test:beta
.venv/bin/python -m unittest discover -s tests
npm --prefix apps/desktop test
npm --prefix apps/desktop run build
```

Browser tests create disposable local accounts and delete them afterward. They reject a non-local backend. Normal test runs never open a physical webcam. The inference scenario uses synthetic video in desktop Chromium; timer, history, settings, export, and recovery scenarios also run in Firefox, desktop WebKit, and mobile WebKit.

The regressions cover authentication request failures, cross-tab authentication locks, stale connection messages, exact pending-save retries after reauthentication, a disconnected saved camera, release of late camera permission requests, history filters/pagination, 205-record JSON/CSV exports, reflections/tags in exports, persistent preferences, keyboard deletion, and 200% text enlargement.

Safari's default keyboard policy uses Option-Tab for buttons, so WebKit keyboard tests use that shortcut. See [Apple's keyboard navigation documentation](https://help.apple.com/safari/mac/8.0/en.lproj/cpsh003.html). Authentication still uses exclusive native Web Locks across tabs. Its callback returns an outcome before propagating errors, avoiding the caught-callback page error observed in Firefox; see the [upstream lock issue](https://github.com/supabase/supabase-js/issues/936).

## Production prerequisites

Required inputs: authenticated Supabase CLI access, the intended organization/region, a Google Cloud OAuth client, and a verified production SMTP sender. Store credentials through provider settings or ignored environment files, never in this document or browser source.

1. Create/link the production Supabase project, review migrations, and apply them with `supabase db push`.
2. Resolve the existing Sites project's actual origin. Configure Auth's site URL and the exact `/auth/callback` and `/auth/reset` redirects on that origin.
3. Enable verified-email signup, a minimum ten-character password, production SMTP, and Google sign-in. Add the beta account as a Google OAuth test user where required by the configured consent-screen audience.
4. Set the Edge Function's `ALLOWED_ORIGINS` to the site origin and deploy `api`. Privileged Supabase keys remain server-side.
5. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in the ignored production build environment; run `npm --prefix apps/web run build:release`.
6. Record the provider's configured backup retention and verify that Privacy & tracking describes it accurately. Do not claim immediate deletion of provider backups.
7. Package only validated public output and publish to the existing owner-only Sites project. Verify the deployment succeeds before marking it published.

## Hosted acceptance

- Google sign-in/cancellation; email signup, verification/resend, password reset, and sign-out with a real inbox.
- Direct loading and refresh of `/analysis`, `/record`, `/settings`, `/privacy`, session summaries, and both authentication callback routes.
- Camera-free start, break, resume, save, then sign in on a second device and verify the same report.
- Competing tabs, a lost save response, reauthentication, and actual 30-second loss-of-contact expiry. Saved study time must stop at the last acknowledged checkpoint.
- Search, mode/status/date filters, timezone changes, reflections/tags, complete exports, session deletion, and deletion of a disposable acceptance account.
- Two disposable accounts cannot read or change each other's records.
- Desktop/mobile navigation, keyboard controls, 200% text, and no unintended page overflow.

Use separate disposable acceptance accounts for destructive checks. Never point the automated local integration suite at production.

## Physical camera acceptance (operator required)

1. Open the private beta in desktop Chrome. Start a session with camera enabled and confirm tracking is ready.
2. Remain in view continuously for more than ten minutes. Verify the whole continuous presence block becomes Deep study. If tracking drops, record the result; do not substitute synthetic observations or adjust saved timestamps.
3. Step out of view for at least 15 seconds, return, and confirm the estimated-away interval and subsequent presence. Verify the labels remain presence estimates, not claims about mental concentration.
4. Take a break and confirm capture stops; resume and confirm it restarts. Hide/show the preview, disable tracking, and end the session. Confirm the camera indicator turns off.
5. Compare live and saved totals. Inspect network requests: only compact presence intervals may be sent, never frames, images, or landmarks.
6. Record browser/device, elapsed duration, observed transitions, and any limitations below. Do not store video or screenshots containing camera imagery as acceptance artifacts.

## Acceptance record

Updated: 2026-09-15. Local automated validation is complete; production prerequisites and physical-camera participation are pending. No hosted acceptance or physical accuracy result is implied by passing automated tests.

| Check | Result |
| --- | --- |
| Web unit, database, parity, and release checks | 52 passed |
| Web TypeScript and production-mode build | Passed with local development configuration |
| Real local API integration | 3 passed |
| Chromium, Firefox, desktop/mobile WebKit | 49 passed; 3 duplicate synthetic-camera cases skipped |
| Desktop Python tests | 100 passed |
| Desktop frontend tests and build | 64 passed; build passed |
| Visual review | Desktop and mobile analysis reviewed; all four browser targets pass the 200% text layout check |
| Production release command | Correctly refused local backend configuration |
| Hosted beta, Google OAuth, external SMTP | Blocked on provider access/configuration |
| Physical camera session | Pending operator participation; no physical accuracy claim |

Production status: Supabase CLI reported no authenticated account, and no connected browser was available for provider setup. No production project is linked and no production web environment is configured. The registered Sites project has no published version. Google/SMTP setup and provider backup retention remain unverified.

For failed saves, retain only the Edge Function request ID, HTTP status, and error code from provider logs. Do not log authentication tokens, email addresses, task names, reflections, images, or landmarks. Roll back frontend/function versions if necessary; migrations remain append-only.
