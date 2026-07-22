# TASK 133 — SEC-AUTH-08's idle lock NEVER RUNS: `ShellSession` has zero production callers and `Root` hardcodes `locked={false}`

**Status:** done
**Priority:** **HIGH — security.** api/02-auth §6.4 makes the idle lock a security control. A shared shop-counter terminal never locks. The SEC-AUTH-08 UI leg is currently green over a mechanism that is not composed — the tasks 60/69/122 shape, on a security surface.
**Depends on:** 14 (session/`checkIdle`), 119 (the live shell)
**Blocks:** 28 (the SEC roll-up should not close while a SEC-AUTH-08 leg is inert)
**SEC ids owned by THIS task:** SEC-AUTH-08 (UI leg — the lock actually firing). Do NOT retire the id anywhere else until this lands.
**Filed by:** QA test-honesty sweep, 2026-07-22.

## The finding (verified by the orchestrator, greps reproduced)

- `apps/mobile/src/session/shell-session.ts` — "SEC-AUTH-08's UI half". Its **only** importer is `shell-session.test.ts`. `src/state/user-workspaces.ts` and `src/session/port.ts` are reachable only through it → transitively dead.
- The sole reference from shipping source is a **comment**: `App.tsx:6` names `session/shell-session.ts`. **A mention is not a producer (T-16).**
- `Root.tsx:429` passes **`locked={false}` as a literal**. Nothing computes it.
- `SessionManager.checkIdle()` has no production caller (core + `shell-session.ts` + tests only).
- `bootstrap/session.ts` constructs `SessionManager` **without** `idleLockSeconds`, so the tenant's configured value (server clamp 60–3600, fully tested server-side) never reaches the device. `setIdleLockSeconds` likewise has no caller.

**Falsification already performed (reported by the sweep, reproduce it before you start — T-11):** made `ShellSession.tick()` throw → only `src/session/shell-session.test.ts` red (8 tests, *including the two titled `SEC-AUTH-08 — a lock preserves work…`*). No composed test noticed. Reverted.

Honestly disclosed in a code comment (`bootstrap/session.ts:22-26`) — but **not tracked as a task** until now, which is why it has sat.

## Deliverable
1. Compose `ShellSession` in `Root`: a real idle tick driven by the app clock + `AppState`, `locked` derived from the session snapshot (not a literal), work retention preserved per `user-workspaces.ts`.
2. Thread the tenant's `idleLockSeconds` from the bundle into `SessionManager` (`bootstrap/session.ts`) — including refresh via `setIdleLockSeconds` when the bundle changes.
3. The unlock path re-enters PIN through the existing `onSubmitPin` seam; a lock must NOT discard the half-written note (that is the whole point of `user-workspaces.ts`).

## FALSIFY (§2.11 — REPORT it)
- **The composed test is the deliverable, not the unit test.** Add a test that mounts the real `Root` (not a substituted factory — see task 137) and advances the clock past `idleLockSeconds` → the shell locks, a draft survives, PIN unlocks. Then break the composition (revert `locked` to `false`, or drop the tick) → **that composed test must red**. Restore → green. Report both.
- Positive control: with idle *below* the threshold nothing locks (so the test can distinguish).

## Constraints
`Root.tsx` is contended (119/124 in flight) — serialize. Do not change `SessionManager`/`checkIdle` semantics in `@bolusi/core`; this is composition, not new policy. Read `api/02-auth §6.4` + `02-permissions` before touching lock policy; a new lock *rule* would be a §6 red flag.


---

## DONE 2026-07-22 (merged; reviewed APPROVE — SECURITY deliverable falsification-proven).

`ShellSession` now runs in composition: an idle tick on a `TimerPort` + one on every `AppState` resume, `locked` derived from the session snapshot (not the `false` literal), `idleLockSeconds` threaded bundle → `meta_kv` → `SessionManager` (core's existing `clampIdleLockSeconds`, no new rule), unlock through `ShellSession.unlock()`. `Root`'s `appState`/`timer` are REQUIRED props so the wiring can't silently go missing again.

**Security behaviour proven, not asserted (reviewer reproduced all falsifications):** a lock emits a real `auth.session_ended('idle_lock', source:'system')` op through the real command runtime into the real op log, read back from the **`auth_sessions` projection** (not a spy). Sabotaging `tick()` reds **all four composed `live-shell-idle-lock` tests** (pre-fix only the unit test would); dropping the tick reds the composed tests while `idle-ticker.test.ts` stays green (the "sound tests, dead caller" property closed); the 59s/61s positive control reds in BOTH directions.

**Residual, honestly bounded (NOT security):** the work-retention PATH is live+tested but has **no producer** — no screen writes into it, so a half-typed note is still lost on a real device today. That is UX, not a lock failure (the lock fires and clears identity regardless). Now tracked as **task 155** (the reviewer's F1 — the "owned by other tasks" comment was false when written; 155 fixes it and wires `withDraft`/`withRoute`).

**Integration (F3):** the branch regenerated the knip baseline against the pre-137 gate; at merge it was regenerated under 137's file-aware gate — the diff is exactly +4 built-ahead exports and −3 files (`shell-session.ts`/`user-workspaces.ts`/`port.ts`, which 133 wired live), no surprise additions. Verified on the integrated tree: mobile 622, core 1108, knip 21-files/+0/-0 both canaries, lint/typecheck/i18n green.

**Device ceiling (unchanged, honestly stated):** a `test-renderer`-over-Node lane cannot prove Android delivers the resume `AppState` transition on every path, that a JS interval survives Doze, or process death — D12/D13 device-suite territory. A locked screen is not a locked device.
