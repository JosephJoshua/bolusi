# TASK 103 — `@bolusi/server` exports no test-auth seam, so the chaos harness cannot assert the HTTP-401 `DEVICE_REVOKED` path (blocks CHAOS-05 T7)

**Status:** in-progress
**Priority:** **MEDIUM** — a producer-traced capability gap the chaos harness needs; not a production bug. The harness can drive the happy path (its `verifyToken` override accepts) but cannot make the real server EMIT a `401 DEVICE_REVOKED`, so CHAOS-05's revoked-device leg and any 401-code assertion are unbuildable until the server exposes a test-auth seam.
**Depends on:** 16
**Blocks:** 26 (the CHAOS-05 revoked-device leg)
**SEC ids owned by THIS task:** none (a test-seam export; the auth behavior it exercises is task 16's SEC-SYNC/DEVICE_REVOKED)

## The finding (task 26 partial, producer-traced by impl-26b)

The harness boots the real `@bolusi/server` in-process and overrides `verifyToken`. But:
- `app.onError` maps only `err instanceof ApiError` to an envelope (`apps/server/src/app.ts:58-60`).
- `ApiError`, `createVerifyToken`, and `InMemoryTokenStore` are **internal** — `apps/server/src/index.ts` exports only `createApp` / `routes` / `AppType`.
- So the harness's injected `verifyToken` can accept a token (happy path) but cannot cause the server to render the exact `401` / `DEVICE_REVOKED` envelope, because producing an `ApiError`-shaped rejection from a test seam isn't reachable through the public surface.

Consequence: CHAOS-05 T7 (revoked-device sync → `401 DEVICE_REVOKED`, halt drain) and any scenario asserting a wire auth-error code cannot be written against the real server. The harness must NOT fake the 401 (T-7 — no protocol logic in the harness); the server must expose the seam.

## Acceptance

- Export a minimal TEST-AUTH seam from `@bolusi/server` that lets a caller (the harness) make the real server reject a device with the genuine `401 DEVICE_REVOKED` (and ideally `AUTH_TOKEN_INVALID`) envelope through the real `onError`/`ApiError` path — e.g. export `ApiError` (or a factory) and/or allow the injected `verifyToken` to signal revocation such that the middleware raises the real `ApiError`. Choose the smallest export that keeps protocol logic in the server (T-7), not a new bypass.
- **Do NOT weaken production auth** (§6): the seam is for INJECTING a revoked verdict in tests, never for skipping auth in production. Confirm the production `createVerifyToken`/token store path is unchanged.
- **Falsify (§2.11):** a harness/integration test that, via the new seam, drives a revoked device through a real sync push → asserts the real server returns `401` with `DEVICE_REVOKED`; break the seam wiring → the assertion fails (no 401 / wrong code). This is what CHAOS-05 T7 will build on.
- `pnpm typecheck`/`pnpm lint`/`pnpm test` (incl the server lane) green — read the output (§2.1).

## Note
Filed from task 26's partial delivery. This is the T-7 discipline working: the harness hit a real capability gap (it cannot produce a wire 401 without the server's help) and FILED it against the owning package rather than forging the 401 itself. Whoever resumes task 26's CHAOS-05 leg depends on this landing first.
