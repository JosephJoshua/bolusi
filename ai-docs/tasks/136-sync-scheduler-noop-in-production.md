# TASK 136 — every local append schedules sync into a NO-OP: the shipping runtime binds `syncScheduler: { schedule: () => undefined }`, and the real `createSyncTriggers(...).scheduler` has zero consumers

**Status:** in-progress
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
