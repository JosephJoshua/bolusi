# TASK 105 — wire the realtime RN adapters in apps/mobile so `RealtimeController` actually runs (it is built-ahead + INERT in the app today)

**Status:** todo
**Priority:** **MEDIUM** — task 20 shipped + falsified the platform-free `RealtimeController` (`@bolusi/core/realtime`) + the server WS/SSE poke hub, but explicitly scoped OUT the RN socket/fetch adapters ("Out of scope: … RN socket/fetch adapters (24)"). Task 24 (app-shell) is `done` but predated task 20, so it never wired them. So `apps/mobile` has ZERO realtime references and the controller is never instantiated — the app gets **no pokes**; it falls back to the 60 s periodic sync trigger only. Correctness is fine (FR-1146 — realtime is purely additive), but the low-latency realtime path is inert until this lands. Same "typed and compiling ≠ running on the target" shape as task 40 → [[102-wire-denial-audit-timer-in-production]].
**Depends on:** 20, 24
**Blocks:** — (activates task 20's client half)
**SEC ids owned by THIS task:** none new (the SEC-RT ids are proven in task 20's core+server tests; this wires the adapters)

## The finding

`packages/core/src/realtime/controller.ts` `RealtimeController` + `RealtimeControllerDeps` (`ports.ts`) are platform-free, needing injected **socket factory** (WS), **SSE-reader factory**, **fetch/transport**, and `ClockPort`/`RuntimeTimerPort` seams. Nothing in `apps/mobile/src` constructs them (grep for `realtime`/`RealtimeController`/`poke` → empty). knip flags `RealtimeController` as an unused export (baselined as built-ahead, task-20 merge).

## Acceptance

- In `apps/mobile`, construct `RealtimeController` with real RN adapters: a WebSocket factory (RN `WebSocket`, authenticated with the device bearer at connect — NOT a query-string token, per SEC-RT-01), an SSE-reader factory, the existing device fetch/transport, and the app's `systemTimer`/clock. Wire `poke → the task-15 sync loop trigger` (the same `trigger()` the controller expects) and start it after enrollment/boot (alongside the sync loop), tearing it down on logout/revocation.
- **Falsify (§2.11) against the REAL mobile composition (not the core fixture — task 20 proved the library):** a test that composes the app's realtime the way boot does, delivers a `sync.poke` frame through the real adapter seam, and asserts the sync loop's `trigger()` fired (one pull, single-flight — never a parallel loop). Then remove the wiring → the poke triggers nothing → RED → restore → green. Also confirm FR-1146 holds in the composed app (realtime down → periodic trigger still converges).
- Respect task 20's constraints: no `ws`/`hono` in core (RN's own WebSocket in apps/mobile only); the poke carries no data (consume the frozen `sync.poke` schema); no realtime-owned pull cadence (the controller calls `trigger()` on poke + connect only).
- `pnpm typecheck`/`pnpm lint`/`pnpm --filter @bolusi/mobile test` green — read the output (§2.1). On merge, knip will resolve `RealtimeController` from the baseline (it's now used) — regenerate the baseline if so.

## Note
Filed from the task-20 merge. Task 20 correctly scoped itself to the platform-free controller + server hub and deferred RN adapters to "24" — but 24 shipped before 20 existed, so the adapter wiring fell through the gap. This is the client-activation half, the realtime analogue of task 97 (client auth registration) and task 102 (denial-timer activation): a mechanism that compiles but isn't wired on the target does nothing.
