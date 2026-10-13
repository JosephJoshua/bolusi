# TASK 216 — interleaved pull double-applies a rebuilt projection

**Priority:** MEDIUM — reproducible core API defect; no production caller of the rebuild API was found, so this is not proof of a current end-user data loss.
**Depends on:** —
**Docs to read:** `04-module-contract.md` §§4.2–4.4; `testing-guide.md` CHAOS-08.
**Skills:** `implement-task`, `review-wave`, `qa-sweep`.
**Files / modules:** `packages/core/src/projection/rebuild.ts`, `packages/core/src/projection/engine.ts`, projection tests.
**Filed by:** 2026-10-13 v0 review; two independent reviewers reproduced with an isolated SQLite notes applier.

## Reproducing failure

Pause `rebuild` after one batch (`stopAfterBatches`); deliver a pulled out-of-order op to the same entity; resume rebuild. `applyPulledOp` re-folds the full entity history while the rebuild cursor still points into that history. The resumed batch then applies already-folded edits again: observed `edit_count=4` where the canonical fold gives `2`. The existing interruption tests insert log entries but do not apply the pulled op between batches.

## Acceptance / falsification

- Cover paused rebuild plus interleaved out-of-order pull against the real notes applier and assert projection rows/digest equal a fresh canonical fold (including `edit_count=2`), without losing the new op or watermark progress.
- Keep batch/cursor atomicity and interruption resume; remove the interleaving guard to demonstrate a red test, then restore it. Determine synchronization/serialization appropriate to actual callers rather than just resetting the cursor in the test.
