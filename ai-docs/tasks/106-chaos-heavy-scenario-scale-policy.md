# TASK 106 — decide + wire the scale policy for the heavy CHAOS scenarios (CHAOS-03, and CHAOS-08 at nightly ×4), then ship CHAOS-03

**Status:** in-progress
**Priority:** **MEDIUM** — a testing-strategy decision that BLOCKS shipping CHAOS-03 (days-offline bulk merge) and de-risks the nightly. impl-26c correctly REMOVED CHAOS-03 rather than ship it unverified-at-scale or silently cut its volume — the decision is above an impl agent's remit (it's a CI/spec policy in testing-guide §3.7).
**Depends on:** 26
**Blocks:** 26 (the CHAOS-03 leg)
**SEC ids owned by THIS task:** none

## The finding (task 26 continuation, impl-26c — measured, not guessed)

1. **CHAOS-03** (§3.6, ~14,000-op days-offline merge) is **>120 s/seed** BOTH via the real HTTP server AND via direct engine feed (both measured to time out at 2 min). The cost is the re-fold-heavy convergence oracle over a 14,000-op universe (O(universe × devices) with per-entity re-folds), independent of transport. At seeds 1–10 in the per-seed merge gate that is >20 min for one scenario — impractical for CI stage-11.
2. **CHAOS-08** is ~54 s/seed at the spec 20,000 (fits the 120 s per-test timeout in the CI gate at seeds 1–10 ≈ 9 min), but at **nightly ×4** (80,000 ops) × 100 seeds it is impractical.

The scenario LOGIC + both wire-property halves of CHAOS-03 (incremental transfer counts, ≤500/batch) are already **built + falsified at reduced scale** (480 ops) — ready the moment a policy is set. impl-26c did not ship them because the acceptance forbids silently cutting volume and §2.1 forbids shipping an unverified-at-scale test.

## The decision (pick one per scenario, record it in `testing-guide.md` §3.7, then wire it)

Options for the heavy scenarios (CHAOS-03 full volume; CHAOS-08 nightly ×4):
- **(a) Nightly-only at full volume, CI at a reduced-but-honest volume** — the CI gate runs CHAOS-03 at e.g. 2,000 ops (still multi-device contention, still the two wire properties), the nightly runs the full 14,000; the CI volume is DOCUMENTED as reduced (not silent). Same for CHAOS-08 nightly-×4 sampling fewer seeds.
- **(b) Fewer CI seeds for the heavy scenarios** — CHAOS-03/08 run 1–2 CI seeds instead of 1–10; document it.
- **(c) Raise the harness `testTimeout` for these scenarios** — only if the wall-clock is acceptable for the gate (it is not, for CHAOS-03 at 20+ min).
Recommended: (a) for CHAOS-03 (a documented reduced CI volume + full nightly), and a nightly seed-sample for CHAOS-08 ×4. Whatever is chosen, it must be EXPLICIT in testing-guide §3.7 + the scenario header — a silently-reduced volume is exactly what the acceptance forbids.

## Acceptance

- Update `testing-guide.md` §3.7 (and the CHAOS-03/08 scenario headers) with the chosen policy, stated explicitly (which volume runs in the CI gate vs the nightly, and why).
- Ship CHAOS-03 at the decided CI volume (its logic + wire-property assertions are ready) with its positive control watched red; run the full nightly volume at least once to prove it passes (record the seed + wall-clock).
- Confirm the CI stage-11 wall-clock stays acceptable (state the measured per-seed time and the total).
- `pnpm chaos` green; every failure reproducible from its printed `CHAOS_SEEDS=N CHAOS_SCALE=S pnpm chaos` command (§3.7).

## Note
Filed from task 26's continuation. This is the honest tail of "harness-scale volumes": the spec numbers (14k merge, 20k rebuild ×4 nightly) meet the reality of a per-seed merge gate, and the resolution is a stated policy, not a silent trim. impl-26c measured both paths and escalated rather than fudge — the right call (§2.1).
