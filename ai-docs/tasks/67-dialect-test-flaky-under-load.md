# TASK 67 — `db-client/test/dialect.test.ts > "rolls back on error"` times out at 5000ms under parallel load

**Status:** todo
**Priority:** **LOW** — a real T-10 violation (a flaky test is a P1 *bug*, but this one is a test-harness fragility, not a product defect). It has never gone red in isolation; it reds only when the machine is saturated.
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** none

## The finding (task 55 merge verification, 2026-07-15)

Running `pnpm test` on the post-55 integration tree **while impl-49 was also running** (load avg 5–9), the full suite came back **`1 failed | 176 passed (177)` / `2570 passed | 3 skipped` / EXIT=1**. The single failure:

```
FAIL |db-client| test/dialect.test.ts > a Kysely transaction rolls back on error
Error: Test timed out in 5000ms.
```

**Re-run in isolation on the same tree** (`pnpm -F @bolusi/db-client test`, no competing agent): **`6 passed (6)` / `87 passed (87)` / EXIT=0.** The test passes; the 5000ms default vitest timeout was simply exceeded because a real DB transaction was competing for CPU with a full monorepo suite plus another agent's test run.

**Not caused by task 55** (established before merging 55): 55's diff touches only `package.json` scripts, `.github/workflows/ci.yml`, `scripts/check-test-script-builds.mjs` + its test, and docs. It does **not** touch `dialect.test.ts` or any transaction code. The build-prefix change cannot alter a test's runtime. So this is a pre-existing fragility that saturation surfaced, not a regression — which is why 55 merged over it.

## Why it matters anyway (T-10)

`testing-guide.md` T-10: *"A flaky test is a P1 bug. No quarantine, no auto-retry-until-green. Fix the nondeterminism or delete the test with a written cause."* A 5000ms wall-clock timeout on a test that does real I/O **is** nondeterminism: its pass/fail depends on machine load, not on the code under test. In CI, where this suite runs beside others on a shared runner, it is a latent red — and a test that reds for reasons unrelated to the code teaches everyone to re-run until green, which is precisely how a real regression later gets waved through as "probably the flake again."

## Acceptance

**Observable done-condition:** the test's pass/fail no longer depends on ambient load, and the fix is proven by making the *timeout*, not the machine, the variable.

- **Reproduce it deterministically first** (T-11) — do NOT just bump the timeout and call it fixed. Establish the actual transaction wall-time under contention: run it with an artificial CPU load (or a tightened timeout) until it reds on demand. You are looking for *how long the transaction really takes when starved*, so the new bound is derived, not guessed.
- **Then decide the real fix, and say which:**
  - If the transaction legitimately needs more than 5 s under load, a **generous, justified** `testTimeout` (with a comment stating the measured worst-case and why) is honest. A bare `testTimeout: 30000` with no measurement is the same guess wearing a bigger number.
  - If 5 s *should* be plenty and the test is doing avoidable work (real timers, an unmocked sleep, a container spin-up inside the test body), fix that — a transaction rollback assertion should not take seconds.
- **Sweep the class** (T-12): this is unlikely to be the only test with a tight wall-clock bound over real I/O. Which other tests do real DB/network work under the default 5000ms? A grep for real `await`ed I/O in tests with no explicit timeout is the start. Report the list; fix only `dialect.test.ts` here unless others are trivially the same.
- **Falsify** (§2.11): whatever bound you set, prove the test still *fails* when the behaviour it checks is broken (make the rollback not roll back → RED), so a longer timeout hasn't turned it into a test that passes because it never really runs. A generous timeout on a test that no longer asserts anything is a worse outcome than the flake.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green — **read the output, not the exit code** (§2.1), and run the suite **under load at least once** (beside another agent, or with the box busy) so "green" means "green when it matters," not "green on an idle machine."

## Note

Filed honestly rather than buried: the orchestrator saw this red during task 55's merge verification and had every incentive to call it "just a flake" and move on. It re-ran in isolation, confirmed the pass, confirmed 55 didn't cause it, and merged 55 — but a test that reds under load and greens in isolation is the exact thing T-18's *"a passing suite and a reaped one are separated by load"* warns about from the other direction: **load is a hidden variable in this repo's test outcomes**, and the machine is routinely saturated because many agents run at once. This is worth a durable fix, not a re-run.
