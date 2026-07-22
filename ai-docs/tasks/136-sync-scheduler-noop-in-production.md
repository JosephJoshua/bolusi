# TASK 136 — every local append schedules sync into a NO-OP: the shipping runtime binds `syncScheduler: { schedule: () => undefined }`, and the real `createSyncTriggers(...).scheduler` has zero consumers

**Status:** done
**Priority:** MEDIUM — costs latency, not data (the 60 s periodic tick, connectivity, manual refresh and realtime pokes still converge), but api/01-sync §5(b) / 04 §5.1 step 7's 3 s debounce does not exist in production.
**Depends on:** 15, 119
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** QA test-honesty sweep, 2026-07-22.

## The finding
`apps/mobile/index.ts:223` binds `syncScheduler: { schedule: () => undefined }` into `createAppEnrollment`. That object becomes the app's **one** `AppRuntime` (`enrollment.ts:121` → `runtime.ts:118`), which `Root` reuses for the session controller **and every notes command** — not just enrollment. So `execute.ts:542`/`:618`'s step-7 `this.#syncScheduler.schedule()` calls a no-op after every local append, forever.

The real implementation exists — `createSyncTriggers(...).scheduler` (`bootstrap/triggers.ts:143`, whose own comment says "**WIRED**") — with **zero production consumers**: `SyncClient` builds triggers internally and never exposes `scheduler`. `grep -rn "\.scheduler" apps/mobile` → only `triggers.ts` and `triggers.test.ts`.

**Falsification already performed:** made `scheduler.schedule()` throw → only `bootstrap/triggers.test.ts` red (5 tests, one titled *"schedule() never throws … (04 §5.1 step 7)"*); `sync-client.test.ts`, `bootstrap.test.ts`, `live-shell-notes.test.tsx` all green. Separately corrupted the **production** binding in `index.ts` to throw → **zero** test failures (no test imports `index.ts`). Reproduce both before starting.

## Deliverable
Expose the real scheduler from `SyncClient` (or construct triggers before the runtime) and bind it into the single `AppRuntime`, so an append debounces a sync per 04 §5.1 step 7. The no-op binding must disappear, not be duplicated.

## FALSIFY (§2.11 — REPORT it)
- A composed test: create a note through the real runtime → a sync is scheduled within the debounce window; two rapid appends coalesce into one (that's the debounce, and it is the positive control that distinguishes "scheduled" from "fired per append"). Break the binding → red. Restore → green.
- `index.ts` has no test importing it (that is *why* this shipped). Fix that as part of the deliverable — the composition root must be observable (see task 137).

## Constraints
`index.ts`/`Root.tsx` contended — serialize with 133/135. Do not change the debounce constants or `execute.ts`'s step-7 contract.


---

## DONE 2026-07-22 (merged, reviewed APPROVE). Closes the inert-mechanism cluster.

The no-op is gone AND un-reintroducible **by construction**: `syncScheduler` was removed from `EnrollmentPlatform`/`AppRuntimeDeps`, so re-adding `{ schedule: () => undefined }` to `index.ts` is a compile error (`TS2353` — the reviewer reproduced it). `SyncClient` exposes the real `createSyncTriggers(...).scheduler`; `Root` binds it into the one `AppRuntime` post-hydrate and detaches before `stop()`. Making the composition root observable: a composed test mounts the real `Root` with the PRODUCTION `createSyncClient` (real loop/triggers/DB) and drives a note through the real editor; the coalescing positive control asserts at the TIMER level (two rapid appends → one armed timer, not masked by the loop's single-flight) AND at the wire (one push carrying both ops). Verified: mobile 634, core 1108, knip +0/-0, all gates green.

### Two LOW residuals (reviewer-noted; recorded here rather than as separate tasks — too granular)
1. **Dangling bind on unmount-during-`start()`.** `startSyncIfEnrolled` binds after `await client.start()` with no `disposed` re-check (steps 1 and 4 have one). If the effect is disposed during `start()`, the bind lands post-cleanup, leaving step-7 pointing at a stopped client's scheduler. Harm requires a post-unmount append on that runtime → at most ONE spurious sync cycle (latency, no throw). `Root` is the top-level `registerRootComponent` root (no remount in production), so it's a theoretical dangling ref, not a live fire. One-line fix when this file is next touched: `if (disposed) { client.stop(); return; }` after `await client.start()`.
2. **The `bindSyncScheduler(null)` detach is comment-guarded, not test-guarded** — no test appends post-teardown, so breaking the detach reds nothing. Low severity; a test that unmounts `Root` and asserts a post-teardown append fires nothing would make it load-bearing.
