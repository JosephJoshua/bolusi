# TASK 134 — push delivery has NO production caller on the server: `sendSyncWake`/`sendConflictSurfaced`/`sendDeviceAlert`/`ExpoPushSender` are dead, and three comments claim otherwise

**Status:** todo
**Priority:** **HIGH** — the whole notification product is built, tested and unreachable. `POST /v1/push/tokens` (tasks 21/118) receives tokens nobody ever sends to, and nothing is ever delivered.
**Depends on:** 16, 17, 21
**Blocks:** 135 (client half is pointless without this)
**SEC ids owned by THIS task:** none directly, but device-revocation alerting (api/04-push §3) is a security-adjacent notification — do not weaken tenant scoping when wiring.
**Filed by:** QA test-honesty sweep, 2026-07-22 (verified by the orchestrator).

## The finding

`sendSyncWake` (`push/fanout.ts:142`), `sendConflictSurfaced` (`:176`), `sendDeviceAlert` (`:203`) and `ExpoPushSender` (`expo-sender.ts:85`) have **zero non-test call sites**. `deps.ts` has **no `pushPort` field at all**. Every non-definition hit is `test/integration/push/fanout.test.ts` or `push/expo-sender.test.ts`.

**The comments are the guard, and they are false (T-15/T-16):**
- `fanout.ts:14` — "The trigger functions below are what tasks 16/17 and the anomaly path call". Tasks 16 and 17 are both `done`; **neither calls them**.
- `fanout.ts:174` — "Wired to `deps.onConflictSurfaced` in composition". It is not.
- `port.ts:3` — "Production binds `ExpoPushSender`". Production binds nothing.

**Related, same vertical — `onConflictSurfaced` is wired only by tests.** `pipeline.ts:337` fires `await deps.onConflictSurfaced?.(conflict)`, but `deps.ts:293` only sets the key when an override supplies one and `main.ts` passes `createApp({ clientIp, systemKeyStore })`. Every provider in the repo is a test file or `packages/harness/src/server.ts`. So every "a surfaced conflict fires the notification hook" assertion passes **because the test installed the hook the shipping server never installs**.

**Falsification already performed:** broke all four mechanisms (throw on entry) → `pnpm test:server` `Test Files 2 failed | 72 passed (74)` / `Tests 18 failed | 500 passed (518)` / `EXIT=1`, with **only** the two push test files red — sync push, conflict detection, conflict wiring, anomalies and device revocation all stayed green. Reverted → 74/74, 518/518, `EXIT=0`. Reproduce before starting (T-11).

## Deliverable
1. Add a **`pushPort` to `resolveDeps`** with a real production default (`ExpoPushSender`, configured from env per `08 §8`) and a fake in tests. Absent config must fail *closed and loudly at boot*, not silently no-op.
2. Bind a **default `onConflictSurfaced`** in `deps.ts` that calls `sendConflictSurfaced` (this is what `fanout.ts:174`'s comment already claims).
3. Call `sendSyncWake` from the sync-push path (api/04-push §5.1) and `sendDeviceAlert` from the revocation/anomaly path (§3) — read the spec for the exact trigger points; do not invent new ones.
4. Fix the three false comments to describe what the code does after the change.

## FALSIFY (§2.11 — REPORT it, real PG16, attributed T-14d)
- A **composed** test (through `createApp`, not through an injected hook) that pushes an op producing a surfaced conflict → the fake `pushPort` records a message. Break the binding in `deps.ts` → that test reds. Restore → green.
- Same for a sync wake and a revocation alert. Positive control: a push with no conflict sends nothing (so "always sends" cannot pass).
- Assert delivery is **tenant-scoped**: a conflict in tenant A never reaches a tenant-B token (zero-relationship control).

## Constraints
`deps.ts` is contended (121/127 in flight) — serialize behind 127. Do not change the fanout functions' signatures or the wire payloads in `api/04-push` — this is composition. If a trigger point is genuinely ambiguous in the spec, STOP and report rather than guessing.
