# TASK 93 — the db-client load-flake class (task 67) also lives in apps/mobile bootstrap tests and secret-scan, still on the default 5000ms

**Status:** in-progress
**Priority:** LOW — no observed failure yet, but it is the **same measured nondeterminism** task 67 fixed, one lane over (T-10: a flaky test is a P1 bug; this is pre-emptive). It will surface as a red CI job under load, indistinguishable from a real failure.
**Depends on:** 67
**Blocks:** —
**SEC ids owned by THIS task:** none

## The finding (task 67's class sweep, T-12)

Task 67 proved `db-client/dialect.test.ts`'s 5000ms red was **worker starvation, not slow code** (idle max 6ms, 4× CPU-oversubscription max 103ms — the 5s was a descheduled vitest worker). It fixed db-client (20000ms, measured). Two lanes carry the **identical class** and were left on the default 5000ms (out of scope, contended with active agents at the time):

1. **`apps/mobile`** — `test/bootstrap.test.ts`, `src/bootstrap/bundle.test.ts`, `src/bootstrap/sync-client.test.ts` drive a **real in-memory better-sqlite3 client DB + migrations**. Exactly db-client's class. The strongest candidate — these run the sync-loop + bootstrap tests that just landed (tasks 50/88/89).
2. **`packages/test-support/src/secret-scan.test.ts`** — spawns **real `gitleaks` subprocesses** (2 tests). Subprocess startup + scan is load-sensitive under 5000ms.

Already protected (do not touch): `core` (30s), `db-server`/`apps/server` (60s/120s, real PG). Not candidates (fake drivers / fs / fake timers / pure logic): `at-rest`, `shipping-deps`, `triggers` (`vi.useFakeTimers`), i18n/schemas/ui/modules/harness.

## Acceptance

- **Follow task 67's method, do not guess** (T-11): measure the real body wall-time of the apps/mobile bootstrap tests under contention, derive the bound (67 used ~200× the heavy-load ceiling and ~4× the worst freeze → 20000ms). A bare bump with no measurement is the same guess wearing a bigger number.
- **Set it at the `apps/mobile/vitest.config.ts` (and `packages/test-support`) package level** (T-12 — the whole lane is the same class), with a comment stating the measurement, mirroring db-client's config.
- **Falsify** (§2.11): each protected test must still go RED on a real behaviour break (not a timeout) — prove the bigger bound didn't make a test vacuous. For secret-scan, breaking the fixture (a real credential the scanner must catch) still reds.
- **secret-scan specifically**: confirm the timeout covers gitleaks subprocess startup under load; the mandatory-scan semantics (SEC-SECRET-02, §10 — hard-fail if gitleaks absent) must be preserved — a longer timeout must not mask a missing gitleaks.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green — read the output (§2.1); run under load once.

## Note
Filed from task 67's sweep. Its author fixed only its own lane (§4 — apps/mobile and test-support had active agents) and reported the rest rather than reaching across contended code — the right call. The lesson task 67 carries: **a 5000ms timeout on a test that does real I/O is a load-sensitivity bug, and the machine is routinely saturated (many agents), so "green on an idle box" is not green.**
