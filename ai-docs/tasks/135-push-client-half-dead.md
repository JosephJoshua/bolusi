# TASK 135 — the app never registers a push token and never routes a notification tap: `registerPushTokenOnAppStart` / `registerPushTokenOnEnrollment` / `resolvePushRoute` have no production importer

**Status:** todo
**Priority:** **HIGH** — client half of the dead push vertical. What *does* ship is `createNotificationChannels` at every boot: channels with no notifications.
**Depends on:** 134 (a server that never sends makes this untestable end-to-end), 119
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** QA test-honesty sweep, 2026-07-22 (verified by the orchestrator).

## The finding
`apps/mobile/src/push/registration.ts:42,63` and `src/push/routes.ts:23` are imported **only** by their own `.test.ts`. Neither `apps/mobile/index.ts` nor `src/bootstrap/Root.tsx` imports `push/registration` or `push/routes`.

**Falsification already performed:** broke `registerPushTokenOnAppStart` and `resolvePushRoute` → only `src/push/registration.test.ts` (5) and `src/push/routes.test.ts` (6) red; every bootstrap/Root/live-shell test stayed green. Reproduce first (T-11).

## Deliverable
1. Call `registerPushTokenOnAppStart` from the composition root once a session exists, and `registerPushTokenOnEnrollment` from the enrollment completion path (api/04-push §2).
2. Install the notification-response listener and route through `resolvePushRoute` → the existing `setRoute` navigation seam (note task 124: `setRoute('settings')` currently has no producer either — the deep-link target must actually be reachable).
3. Handle the permission-denied and token-unavailable cases without crashing the boot; a device that refuses notifications must still work.

## FALSIFY (§2.11 — REPORT it)
- A **composed** test through the real bootstrap: app starts with a session → the fake push port sees a `registerPushToken` call carrying the right device id. Break the wiring → that test reds. Restore → green.
- A tap payload for `conflict` navigates to the sync-status route; an unknown payload navigates nowhere (positive control — so "always navigates" cannot pass).

## Constraints
`Root.tsx` / `index.ts` are contended (119/124/133 in flight) — serialize. Do not change the payload schema in `api/04-push §4`.
