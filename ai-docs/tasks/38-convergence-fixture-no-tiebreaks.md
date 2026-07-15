# TASK 38 — the convergence property test never exercises canonical order's tie-breaks
**Status:** todo
**Depends on:** 35

## Goal

Make the convergence property test actually test canonical order — all three components, not just the first.

**The gap** (self-reported by task 35 while fixing the timeout flake, deliberately not fixed there — out of its file set):

Canonical order is **`(timestamp, deviceId, seq)`**. The convergence fixture generates **120 ops with 120 distinct timestamps and zero cross-device ties**. So every op is fully ordered by `timestamp` alone, and the `deviceId` / `seq` tie-breaks are **never exercised**. Perturbing them leaves the test **green**.

This is the test named *"every random permutation digests byte-equal to the canonical fold"* — the guard on FR-1118 / `04 §4.2`, the load-bearing property of the entire offline-first architecture. It proves materially less than its name implies: it tests that ordering by timestamp converges, not that **canonical order** converges.

**Why ties are not a corner case — they are the actual scenario.** Two devices in the same shop, offline, both writing at the same moment: identical millisecond timestamps are exactly what the `deviceId`/`seq` tie-break exists to resolve. A shared clock granularity of 1ms across concurrent writers makes collisions *ordinary*, not exotic. The one situation where the tie-break decides the outcome is the one situation the property test cannot see.

**What stops this being urgent** (verify before trusting): task 35 reports `CHAOS-07ii` covers ties with hand-built ops, so the class is not wholly unguarded. That is a mitigation, not a substitute — hand-built cases test the ties someone *thought of*; the property test is what tests the ones nobody thought of (T-12). Right now the randomized instrument is blind to two-thirds of the ordering key.

## Docs to read

- `04-module-contract.md` §4.2 + FR-1118 — the convergence property and the canonical order definition.
- `05-operation-log.md` — canonical ordering `(timestamp, deviceId, seq)` and why each component exists.
- `packages/core/src/projection/convergence.test.ts` — post-task-35 (per-seed `test.each`); the fixture generator is the subject.
- `packages/core/src/crypto/order.ts` — the comparator that the fixture fails to exercise.
- `testing-guide.md` T-12 (test the class), T-14 (assert the denominator), T-3 (unique values per case), T-6 (seed reportable).
- Task 35's Outcome section — the measurements and the reason it stopped at the boundary.

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.

## Files / modules touched

- `packages/core/src/projection/convergence.test.ts` — the fixture generator + assertions.
- Possibly `packages/core/test/**` shared fixture factory, if the tie-generation belongs there.
- **`@bolusi/core` is contended (CLAUDE.md §4)** — serialize; do not run beside another core agent.

## Acceptance

**Observable done-condition:** perturbing the `deviceId` tie-break, or the `seq` tie-break, makes the convergence suite go **RED** — and the failure is a digest byte-inequality naming its seed, not a timeout.

- **Prove the gap first** (T-11): perturb `order.ts`'s `deviceId` comparison, run the suite, watch it stay **GREEN**. That green is the bug. Then perturb `seq` — also green. Report both. If either already goes red, the premise is wrong: stop and report that instead.
- **Generate ties deliberately, and assert you generated them** (T-14 — the denominator is the whole point here). The fixture must produce, per seed: ops sharing a `timestamp` across **different devices** (exercises `deviceId`), and ops sharing `(timestamp, deviceId)` (exercises `seq`). **Assert the counts are non-zero per seed** — a fixture that *intends* ties but produces none is this exact bug wearing a fix's clothing, and it would pass silently. Name the numbers.
- **Then falsify properly**: with ties present, perturbing `deviceId` → RED with byte-inequality; perturbing `seq` → RED; restore → green. Both must name the seed (T-6) so a real break is debuggable from a CI log alone.
- **Do not regress task 35's work.** Coverage stays ≥ its 10 seeds × 6 permutations × 120 ops, per-seed head/refold assertions keep their own denominators, and the suite stays inside the 30s ceiling — **measure it** (task 35's post-split numbers: p50 1076ms / p95 2681ms / max 3475ms, n=50). Adding ties should not materially change runtime; if it does, say so with numbers rather than raising the ceiling.
- **Check the sibling fixtures for the same blindness** (T-12 — this is unlikely to be the only one): does any *other* projection/oplog property test generate distinct-timestamp-only data and therefore skip the tie-break? Report what you find. The bug is not "this fixture"; it is "our random fixtures are ordered by construction."
- **Verify the CHAOS-07ii mitigation claim** rather than inheriting it: does it genuinely cover the tie class, and does this task overlap or complement it? If CHAOS-07ii is thinner than believed, that is a finding worth more than the fix.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1).

## Note

Found by task 35 while fixing an unrelated timeout, and reported rather than left as a silent limitation — the second time this session an agent volunteered a weakness in work it had just made green (review-02 did the same on task 09's order-dependent escalation guard).

The pattern is worth stating: **a randomized test's coverage is a property of its fixture, not of its name.** "Every random permutation" sounds exhaustive; it was exhaustive over permutations of a data set that had already been made unambiguous by construction. Randomizing the *order* of ops that can only order one way proves the fold is stable, not that the comparator is right. This is T-13 pointed at a fixture instead of an oracle: ask what the generator can actually produce before believing what the assertion claims to check.
