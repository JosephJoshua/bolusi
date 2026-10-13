# TASK 214 — nightly chaos never finishes its promised coverage

**Priority:** HIGH for the nightly confidence claim; per-PR chaos gates remain separately green.
**Depends on:** —
**Docs to read:** `testing-guide.md` §3.7; `.github/workflows/chaos-nightly.yml`.
**Skills:** `implement-task`, `review-wave`, `qa-sweep`.
**Files / modules:** nightly workflow and harness scenario sampling/budget code; update testing-guide only if coverage policy changes by explicit decision.
**Filed by:** 2026-10-13 v0 review, GitHub Actions run/job metadata plus job logs.

## Reproducing failure

The five most recent `chaos-nightly` jobs through October 12, 2026 ended `cancelled`; the October 12 job ran from `2026-10-12T09:37:15Z` to `15:37:48Z`, exhausting the workflow's 360-minute timeout. The nightly includes 100 seeds for CHAOS-02, an expensive full-volume scenario without a per-scenario cap, so the promised whole-lane results are not delivered. Do not infer that any individual scenario passes from a timed-out job; investigate the previously logged CHAOS-03 failures independently.

## Acceptance / falsification

- Establish measured scenario runtime and an explicit workload/time budget that completes within the CI limit, or deliberately revise the coverage policy and document the reduced evidence; do not silently skip scenarios or turn test failures green.
- Show a completed nightly run and its actual seeds/scale, all scenarios accounted for, with failure status preserved for real scenario failures. Reproduce and triage CHAOS-03 failures before treating a completed lane as green.
- Add a budget/coverage guard that goes red if the declared workload can no longer finish; retain a bounded reproduction command for failing seeds.
