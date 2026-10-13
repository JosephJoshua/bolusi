# TASK 217 — same-version rebuild check skips an unfinished rebuild

**Priority:** MEDIUM — reproducible API defect, conditional on callers using version-gated rebuild; no production caller was found in this review.
**Depends on:** 216 (both change the projection rebuild state machine).
**Docs to read:** `04-module-contract.md` §§4.3–4.4; `testing-guide.md` CHAOS-08.
**Skills:** `implement-task`, `review-wave`.
**Files / modules:** `packages/core/src/projection/engine.ts`, rebuild store/tests.
**Filed by:** 2026-10-13 v0 review; independently reproduced in a durable interrupted-rebuild fixture.

## Reproducing failure

After a partial rebuild whose module signature still matches the stored version, create a fresh engine and call `rebuildIfVersionChanged`. `engine.ts:218` returns `{ rebuilt: false }` without reading the durable in-progress cursor; the projection stays partial. Calling `rebuild` explicitly resumes it.

## Acceptance / falsification

- Persist a partial same-version rebuild and reinstantiate the engine. The version-gated call resumes to a canonical complete projection and reports that work ran.
- A truly complete same-version projection remains a no-op. Corrupt the cursor-handling check temporarily to see the partial-state test go red; restore and pass.
