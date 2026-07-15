# TASK 38 — nothing in the repo tests canonical order's `seq` tie-break
**Status:** todo
**Priority:** LOW-MEDIUM (sized by review-03 — real vacuity, cheap fix, pre-existing, small blast radius; the value is regression protection)
**Depends on:** 35

## Goal

Add the missing tie-break coverage. **Read the precise finding below before planning — the obvious version of this task is wrong.**

Canonical order is **`(timestamp, deviceId, seq)`**. Task 35 self-reported that the convergence fixture never produces ties; review-03 then **split the finding in half, and only one half is a real gap**:

| component | status | evidence |
| --------- | ------ | -------- |
| `timestamp` | covered | the property test orders by it |
| `deviceId` | **covered — do not "fix" this** | perturbing `ORDER BY timestamp_ms, device_id DESC, seq` makes **CHAOS-07ii go RED** (`expected 'from-a' to be 'from-b'`) while all 10 per-seed convergence cases stay green. The property test is blind to it, but CHAOS-07ii genuinely backstops it. |
| **`seq`** | **COVERED BY NOTHING** | perturbing `ORDER BY timestamp_ms, device_id, seq DESC` at all three sites → **whole core package green: 27 files / 503 tests, EXIT=0** |

**Why `seq` is unguarded, precisely:** CHAOS-07ii builds its tie from two *different* devices (`dev-a`/`dev-b`) at an identical timestamp — so `deviceId` resolves the comparison and `seq` is **never consulted**. `oplog-source.test.ts` uses distinct timestamps even within a device. **No test in the repo constructs two ops sharing `(timestamp, deviceId)`** — the precondition for the third component simply never occurs. A textbook T-14b vacuity: the assertion is fine, the *precondition* never happens.

**Why the fixture cannot produce ties — structural, not luck.** Each device gets `clock = base + d*137` and advances only in whole seconds (`(1+floor(prng()*600)) * 1000`), so device `d`'s timestamps are permanently `≡ d*137 (mod 1000)`. Residues 0/137/274 → **cross-device ties are impossible by construction**. Measured: **1200 ops, 0 cross-device ties**. The `d*137` stagger that exists to *interleave* devices is exactly what makes ties unreachable.

**Honest sizing (review-03 talked itself DOWN from higher — don't re-inflate it):**
- The **JS comparator is well covered**: `order.test.ts` deliberately uses a tiny value space (3 timestamps × 3 devices × 3 seqs) to force ties and explicitly tests *"breaks a timestamp+deviceId tie by seq"*. The subtle side is guarded.
- The unguarded side is the **SQL `ORDER BY`** — the second implementation of `05 §4`. But `seq` is `INTEGER NOT NULL CHECK (seq >= 1)`, so SQL and JS cannot disagree via collation; and the server imports only `compareCanonicalOrder`/`canonicalizeJcs` from core, so **the SQL projection path is client-side SQLite only** — no cross-engine collation hazard either. (review-03 suspected one, checked, and was wrong. Don't repeat the suspicion without checking.)
- So **live-bug risk is small.** The real value is **regression protection**: an edit to that `ORDER BY` — a refactor, an index-driven "optimization" — is currently caught by *nothing*. That is precisely the change the perturbation simulated.

**The spec shares the blind spot — fix that too.** `testing-guide.md`'s CHAOS-07 is specified as *"Concurrent same-entity edits, 2+ devices"* and never names the **intra-device same-millisecond** case. So nobody violated the catalogue by not testing it; the catalogue never asked. A test added without fixing the spec leaves the next person with the same gap.

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

**Observable done-condition:** perturbing the **`seq`** tie-break makes the suite go **RED**. (It currently leaves 27 files / 503 tests green.)

- **Prove the gap first, both halves** (T-11 — and this is what stops you fixing the wrong thing): perturb `ORDER BY … seq DESC` → watch the core package stay **GREEN** (that green is the bug). Then perturb `… device_id DESC` → watch **CHAOS-07ii go RED** (that one is already guarded — leave it alone). If either behaves differently than recorded above, the premise changed: stop and report.
- **The fix is ~15 lines**: mirror CHAOS-07ii with **same timestamp + same deviceId + differing seq**. Do NOT rebuild the convergence fixture to manufacture ties — review-03's analysis shows the `d*137` stagger makes cross-device ties structurally impossible, and reworking the generator would risk task 35's verified coverage (10 seeds × 6 perms × 120 ops, per-seed `headApplies + refolds === 720` exactly) for a gap a hand-built case closes precisely. **If you believe the property test itself must generate ties, argue it explicitly against that cost** — don't do it by default.
- **Assert the precondition, not just the assertion** (T-14b — this bug *is* a missing precondition): the new test must prove it actually constructed two ops sharing `(timestamp, deviceId)`. A tie test whose ops don't tie is this exact bug wearing a fix's clothing.
- **Falsify**: with the case present, perturb `seq` → RED; restore → green. Report both.
- **Fix the spec too** — otherwise the gap regrows. `testing-guide.md`'s CHAOS-07 says *"Concurrent same-entity edits, 2+ devices"*; add the **intra-device same-millisecond** case to the catalogue so the requirement exists, not just the test.
- **Do not regress task 35.** If you touch `convergence.test.ts` at all, its per-seed `headApplies + refolds === 720` must still hold for all ten seeds, and runtime must stay well inside the 30s ceiling (post-split: p50 1076ms / p95 2681ms / max 3475ms, n=50).
- **Sweep for the same shape** (T-12): does any other fixture make its precondition unreachable by construction? The bug is not "this fixture" — it is *"our random fixtures are ordered by construction, so the comparator's tie-breaks are unreachable."* Report what you find even if you fix only `seq`.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1).

## Note

Found by task 35 while fixing an unrelated timeout and reported rather than left as a silent limitation; **sized correctly only after review-03 split it** — the first version of this task file said "`deviceId`/`seq` are never exercised" and would have sent someone to re-cover `deviceId`, which CHAOS-07ii already guards, while possibly missing `seq`, which nothing does. Both halves *looked* identical from the property test's point of view; only a perturbation of each told them apart. That is why this file leads with the evidence table.

The pattern worth keeping: **a randomized test's coverage is a property of its fixture, not of its name.** "Every random permutation" sounds exhaustive — and it *was* exhaustive, over permutations of a data set that had already been made unambiguous by construction. Randomizing the order of ops that can only order one way proves the fold is stable; it says nothing about whether the comparator is right. This is T-13 aimed at a fixture instead of an oracle: **ask what the generator can actually produce before believing what the assertion claims to check.** The generator's staggering — added to make devices interleave — is what silently removed the ties the comparator exists to resolve.
