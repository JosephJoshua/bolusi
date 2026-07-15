# TASK 35 — the convergence property test is a P1 flake: 6.6s of real work against a 5s default timeout
**Status:** todo
**Depends on:** 08

## Goal

`packages/core/src/projection/convergence.test.ts` — *"every random permutation digests byte-equal to the canonical fold, seeds 1..10"* — **times out and fails** under concurrent machine load:

```
× every random permutation digests byte-equal to the canonical fold, seeds 1..10   6604ms
  Error: Test timed out in 5000ms.
```

It passes in isolation (4/4, EXIT=0) and passed at task 08's merge. It failed during task 13's integration verification with 5 agents + docker running (load average 9.9–15.5 on 48 cores). It sets **no `testTimeout`**, so it inherits vitest's **5s default**. The gap is not a bug in the test's logic — it is a budget that was never set deliberately.

**The measurement that settles it (from task 29, which hit the same flake independently):** the test does **4.85s of work against the 5s default — 97% of its budget when the machine is *idle*.** Under full-suite load it took 6.6s. Two independent corroborations that this is load, not a real break: task 29 ran the baseline **without** its diff and it failed **3/3** under load while passing in isolation; task 30's suite (1499 tests, unrelated package) passed it unchanged.

**97% of budget at idle is the whole story.** This test was never one bad day away from flaking — it was always going to flake the moment anything else ran on the machine. It passed CI so far by luck of an unloaded runner, which is exactly why the fix must be a *reasoned* budget rather than a bigger round number.

**T-10 makes this a P1**: *"A flaky test is a P1 bug. No quarantine directory, no auto-retry-until-green. Fix the nondeterminism or delete the test with a written cause in the commit subject."*

**Why this one matters more than a typical flake.** This test guards **order-independent convergence** (FR-1118 / `04 §4.2`) — the load-bearing property of the entire architecture. Every device folding the same ops in canonical order must reach a byte-identical state; if that breaks, the whole offline-first premise breaks. A test this important must fail **only** when the property is violated. Right now it also fails when the machine is busy, and those two failures look **identical in CI**. The predictable consequence: someone sees a red convergence test, remembers "that one's flaky," and re-runs it — and the one time it means something, it gets re-run too. **A flake in a crown-jewel test doesn't just cost time; it trains people to ignore the alarm.**

## Docs to read

- `testing-guide.md` **T-10** (flaky = P1 — the rule this closes), T-6 (determinism — every randomized test prints its seed and is reproducible from it), T-11 (falsify before believing).
- `04-module-contract.md` §4.2 + FR-1118 (the convergence property under test).
- `ai-docs/tasks/08-projection-engine.md` — the owning task; the engine and this suite are its deliverable.
- `apps/server/vitest.config.ts` on main — the precedent: it already serialises files and raises ceilings (60s/120s) because PGlite/argon2id suites contend. `packages/core` has no equivalent.

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.

## Files / modules touched

- `packages/core/src/projection/convergence.test.ts`
- `packages/core/vitest.config.ts`
- Possibly a shared vitest config if the fix is repo-wide. **`@bolusi/core` is contended (CLAUDE.md §4)** — serialize; do not run while another core agent is in flight.

## Acceptance

**Observable done-condition:** the test fails **only** when convergence is actually violated — never because the machine is busy.

- **Reproduce first, deliberately** (T-11 — do not fix what you have not watched fail). Run it under artificial load (e.g. saturate cores) and watch it time out. If you cannot reproduce the timeout, do **not** guess at a fix — report that instead. A fix for an unreproduced flake is a guess with a commit message.
- **Decide the real question, don't just raise the number.** Options, and you must justify the choice rather than reach for the easiest:
  1. **Raise `testTimeout` to a defensible budget.** Cheapest and probably right — but state the budget's *reasoning* (measured p95 under load × headroom), not a round number that happens to pass today. An arbitrary 30s is the same bug with a bigger constant.
  2. **Make the work smaller** (fewer seeds/permutations per case, or split one test into per-seed cases so each is small and names its own seed). Note T-2 (one behavior per test) — "seeds 1..10" in a single test is already ten behaviors wearing one name, and splitting fixes the flake *and* the naming.
  3. **Both** — and this is likely correct: split into per-seed cases *and* set a measured timeout.
- **Do not weaken the property to make it fast.** Reducing seed count is acceptable only if you state what coverage is lost and why the remainder still exercises the class (T-12). Cutting permutation coverage to dodge a timeout would trade the architecture's load-bearing guarantee for a green — the exact trade this repo exists to refuse. If the honest answer is "this property needs 6.6s," then it needs 6.6s and the timeout is what's wrong.
- **The seed must be reportable** (T-6): on failure the output names the exact seed to reproduce from, so a real convergence break is debuggable from the CI log alone.
- **Falsify the fixed test** (§2.11): break convergence for real (e.g. perturb the canonical sort so one permutation folds differently), watch it fail with a **byte-inequality** — not a timeout — restore, watch it pass. That is the whole point: the failure mode must distinguish "the property broke" from "the machine was busy."
- **Sweep for siblings.** This is unlikely to be the only heavy test inheriting the 5s default. Check the other `@bolusi/core` property/crypto suites (projection, oplog, jcs) for tests whose real runtime is within ~2× of their timeout, and report them even if you fix only this one — a test at 4.9s/5s is this bug that hasn't fired yet.
- `pnpm test` green **under load**, not just idle. **Read the output, not the exit code** (§2.1).

## Note

Found during task 13's integration verification. Diagnosis that kept it honest: the test is **byte-identical to main** and task 13 touches **zero** files under `packages/core` — so it was a pre-existing latent flake that concurrency exposed, not a regression, and task 13 merged on that basis. Worth noticing that the evidence for "not a regression" was a diff, not a re-run: *"it passed the second time"* is precisely the reasoning T-10 forbids, and it would have reached the same conclusion by luck rather than by proof.
