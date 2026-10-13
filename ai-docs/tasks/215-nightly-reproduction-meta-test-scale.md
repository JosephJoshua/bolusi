# TASK 215 — nightly reproduction meta-test expects the wrong scale

**Priority:** MEDIUM — an unconditional test failure hides actual nightly scenario status.
**Depends on:** — (coordinate with 214 when validating the complete nightly lane).
**Docs to read:** `testing-guide.md` §3.7.
**Skills:** `implement-task`, `review-wave`.
**Files / modules:** `packages/harness/scenarios/reproducibility.test.ts`; verify `packages/harness/src/reporter.ts` stays faithful to the active scale.
**Filed by:** 2026-10-13 v0 review, local reproducing test.

## Reproducing failure

`CHAOS_NIGHTLY=1 CHAOS_SCALE=4 pnpm exec vitest run --project harness scenarios/reproducibility.test.ts --reporter=dot --maxWorkers=2` ends `EXIT=1`: 1 failed / 3 passed. Its line-84 assertion expects `CHAOS_SEEDS=7 CHAOS_SCALE=1 pnpm chaos` while the reporter correctly emits scale 4. The ordinary scale-1 suite passes.

## Acceptance / falsification

- Assert the reproduction string against the active scale rather than a literal 1. Both the default harness lane and `CHAOS_SCALE=4` pass, with a concrete check that removing the scale from a nightly reproduction command fails the guard.
- Preserve the invariant that the command reproduces the *actual* run, not simply that the test accommodates either output.
