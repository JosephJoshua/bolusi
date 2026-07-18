# TASK 21 — push-notifications (token registration, Expo/FCM sender, categories, locale composition)
**Status:** in-progress
**Depends on:** 12, 13

## Goal
Deliver the whole push surface per `api/04-push`. Server: the real `POST /v1/push/tokens` handler on task 12's stub `push` sub-router (device bearer, nullable `user_id` via `X-Acting-User`, upsert keyed by `device_id`, 30/day/device rate limit); an Expo push sender (FCM v1 relay via `https://exp.host/--/api/v2/push/send`) behind a **`PushPort`** interface so every test runs against a fake; category composition for the closed v0 set — `sync` data-only, `conflict`/`device` with server-composed localized title/body rendered from `@bolusi/i18n` `push.*` using the target device's registered user's `user_prefs.locale` (fallback `id-ID`); fan-out recipient resolution that never exceeds pull scope, with 60 s per-device `sync` coalescing; `DeviceNotRegistered` token invalidation from tickets and delayed receipts; and delete-on-revocation wired into task 13's revocation transaction. Client (`apps/mobile`): registration triggers (app-start token diff, post-enrollment), Android channel-per-category creation, the per-category mute toggle (channel importance), and the deep-link route map. Exposes typed trigger functions (`sendSyncWake` / `sendConflictSurfaced` / `sendDeviceAlert`) that tasks 16/17 and the anomaly path call; the live-realtime-connection filter is an injectable hook defaulting to "no device connected" until task 20 lands. Out of scope: WS/SSE (20), conflict-surfacing emission (17), settings-screen UI mounting (24).

## Docs to read
- `api/04-push.md` — **all** (this task implements it end to end); follow only its explicit delegations into `api/00-conventions` (§3 auth/`X-Acting-User` headers, §7 error envelope, §11 429 shape) where §2 points at them.
- `07-i18n.md` — §8 (server-side composition rule: one catalog, `push.*` namespace, recipient's last-synced locale pref, fallback).
- `10-db-schema.md` — §8: `push_tokens` DDL (nullable `user_id` + its comment, `idx_push_tokens_device`, UNIQUE token) and the `user_prefs` projection (the locale read).
- `security-guide.md` — §9 (checklist §9.1 push rows + §9.2 SEC-RT table; the **push legs** of SEC-RT-03/04 land here), §2.1 (checklist binding, test-title IDs).

## Skills
- `superpowers:test-driven-development` — always; the acceptance list below is the test list, written first against the `PushPort` fake.
- `superpowers:verification-before-completion` — run the suites; paste output, not claims.
- `context7-mcp` — verify `expo-notifications` (SDK-57), `getExpoPushTokenAsync`, `setNotificationChannelAsync`, and the Expo push HTTP API (send/getReceipts request-response shapes, ≤100 batch) against current docs before use.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on main.

## Files / modules touched
- `apps/server/src/routes/push.ts` — replace the task-12 stub with the chained token-registration handler (keep `AppType` inference intact); route-scoped rate-limit config (30/day/device) via task 12's `src/middleware/rate-limit.ts` store interface — config only, no middleware rewrite.
- `apps/server/src/push/port.ts` — `PushPort` (send batch → tickets; fetch receipts) + in-memory fake for tests.
- `apps/server/src/push/expo-sender.ts` — Expo HTTP impl: ≤100 messages/request batching, api/04 §8 retry schedule, ticket-error handling, `InvalidCredentials` alert hook.
- `apps/server/src/push/compose.ts` — category → payload composition; locale resolution (`push_tokens.user_id` → `user_prefs` via `forTenant`, fallback `id-ID`); imports `@bolusi/i18n` only for strings.
- `apps/server/src/push/fanout.ts` — recipient queries per api/04 §3 (pull-scope for `sync`; store devices for `conflict`; `auth.device_read`-holding registered users for `device`), 60 s coalescer, injectable live-connection registry hook (default: none connected), post-commit fire-and-forget dispatch, exported trigger functions for tasks 16/17.
- `apps/server/src/push/receipts.ts` — delayed (≥15 min) `getReceipts` polling loop; `DeviceNotRegistered` → row delete.
- Task 13's revocation handler (its file under `apps/server/src/`) — add the `push_tokens` delete **inside the same transaction** (api/04 §2). Coordinate if task 13 work is in flight; this is the only edit outside `push/`.
- `apps/mobile/src/push/registration.ts`, `channels.ts`, `routes.ts` — triggers, channel/mute logic, deep-link map; unit-testable with `expo-notifications` mocked.
- `apps/server/test/integration/push/` + `apps/mobile` unit tests — all suites below.
- **Contended, expected untouched:** `@bolusi/schemas` (push DTOs are task 02's) and `@bolusi/i18n` (`push.*` keys are task 22's ui-labels seed; i18n is contended per CLAUDE.md §4). A DTO or missing-key gap → stop and serialize that change; never fork strings or schemas locally.

## Acceptance
- **Observable done-condition:** `pnpm test:server` green including every suite below (in-process `app.fetch` + `PushPort` fake + fake timers — zero real Expo/FCM calls in CI); `apps/mobile` push unit tests green; `pnpm lint` and `tsc -b` green repo-wide.
- **Registration endpoint tests (`POST /v1/push/tokens`):**
  - No bearer → `401`; pre-login register (no `X-Acting-User`) → `200 { deviceId, updatedAt }`, row has `user_id = null`; with `X-Acting-User` → `user_id` stamped; a later registration with a session fills a previously-null `user_id`.
  - Upsert semantics: re-register with a new token → still exactly one row for the device, token overwritten, `updated_at` server-stamped; byte-identical replay converges on the same row (idempotent by construction); an `Idempotency-Key` header is ignored — no `422`, no replay semantics.
  - `deviceId` ≠ bearer's device → `403 PERMISSION_DENIED`; token not matching `ExponentPushToken[…]` → `422 VALIDATION_FAILED`.
  - **Rate limit:** 31st registration within a day for one device → `429 RATE_LIMITED` with `Retry-After` header + `retryAfterSeconds` detail; a second device is unaffected; window resets under fake timers.
- **Payload rule tests (api/04 §4 — the brief's core):**
  - `sync` is data-only: composed message carries `data.category` and **no** `title`, **no** `body`, **no** `route`, **no** `params`.
  - `conflict` carries exactly `title`, `body`, `data: { category, route: "conflicts", params: { conflictId } }`; `device` exactly `route: "devices"`, `params: { deviceId }` — key-allowlist assertion, any extra key fails.
  - Business-data ceiling: compose against fixtures whose entities contain distinctive names/amounts/note-body strings → serialized output contains none of them; title/body come only from `push.*` catalog keys (generic sentences), `params` values are UUIDs only.
  - `channelId` == category on every visible message.
- **Locale fallback matrix (07-i18n §8, api/04 §4):** `user_id` null → `id-ID` strings; `user_id` set but no `user_prefs` row → `id-ID`; `user_prefs.locale` set (e.g. `en`) → that catalog's strings; composition takes no `Accept-Language` input (unit-level: the compose function has no header parameter and the handler never reads it).
- **Sender / PushPort tests:** >100 recipients split into ≤100-message batches; Expo request failure (network, 5xx, 429) retried on the 5 s → 15 s → 60 s → 5 min-cap schedule, max 5 attempts, then dropped — never queued durably, never re-sent later; sending runs post-commit fire-and-forget — a sender that throws never fails the triggering request (spy on the HTTP response); push failures logged, never surfaced as sync errors.
- **Token lifecycle tests:** register pre-login (above); rotation re-register (above); `DeviceNotRegistered` in a **ticket** → row deleted immediately; `DeviceNotRegistered` in a **receipt** polled ≥15 min after send (fake timers) → row deleted; other per-message errors → logged + message dropped, row kept; `InvalidCredentials` → alert hook fired; device revocation deletes the row **in the same transaction** as the other revocation effects (induced mid-transaction failure rolls back both); no client-facing DELETE route exists.
- **Fan-out scope tests:** `sync` targets only devices whose pull scope covers the accepted op AND that have no live realtime connection (fake registry: connected device excluded) — at most one `sync` push per device per 60 s (fake timers); `conflict` targets every active device of the conflict's store; `device` targets only devices whose registered user holds `auth.device_read` — and devices with `user_id = null` get no `device` pushes (10-db §8); a revoked device / deleted token receives nothing.
- **Client tests (mocked expo-notifications):** app start POSTs only when `getExpoPushTokenAsync` output differs from the persisted last-registered value (identical token → zero requests); enrollment completion triggers registration; channels created per category at app start; mute toggle flips that channel's importance and only that channel's; deep-link map resolves `conflicts`/`devices` routes with their id params and safely ignores unknown route keys.
- **Named SEC tests (security-guide §9.2), titles embedding the ID verbatim — push legs land HERE, before review (CLAUDE.md §2.5); WS/SSE legs are task 20's:**
  - `SEC-RT-03` (push leg) — schema audit over **every** server code path that composes a push: output validates against the api/04 §4 shape; a fixture payload smuggling a business value (amount, name, note body) fails the suite.
  - `SEC-RT-04` (push leg) — activity in tenant B and in tenant A's other store produces **zero** pushes (including data-only `sync` wakes) to a tenant-A store-1 device.
  - Security checklist §9.1 push rows copied per §2.1 and checked off with evidence (file/line or test name): payload-ceiling row; token registered-keyed-to-device / deleted-on-revocation / rotation-re-register row.
- **CHAOS scenarios: none** — no CHAOS-* id targets push (testing-guide §3.6), by design: push is never load-bearing (api/04 §1). Recorded here so review knows nothing was skipped.
- **Lint/CI gates:** SEC-META-01 finds `SEC-RT-03`/`SEC-RT-04` in test titles; the 07-i18n §4.1 no-hardcoded-strings lint holds for `apps/server/src/push/` (title/body via catalog keys only); import-boundary lint green (`apps/server` → `@bolusi/i18n` is an allowed edge, 08 §3.3; no `expo-*` import server-side); `AppType` still compiles and the `hc` smoke test from task 12 stays green; pre-commit hooks pass (no `--no-verify`).
