# TASK 32 — point the CI `server-integration` job at `pnpm test:server`
**Status:** todo
**Depends on:** 12

## Goal

Task 01 scaffolded a named-placeholder CI job `server-integration` (08 §7 bootstrap record #9) that echoes "not implemented — see task 12" and exits without running anything. Task 12 shipped `pnpm test:server` (the Hono app's integration suite — 11 files / 90 tests against the real middleware chain, incl. the SEC-SYNC gzip/auth adversarial tests). The placeholder now hides real coverage: the suite exists and passes locally but nothing runs it in CI.

Wire the job to the real command. This is a CI-verifier-boundary edit, deliberately kept out of task 12's scope (an implementer should not silently repoint the job that gates its own work).

## Docs to read

- `08-stack-and-repo.md` — §5.6 (CI stage table; `server-integration` is stage 8) + §7 record #9 (the placeholder's deferral).
- `ai-docs/tasks/12-server-app.md` — the `test:server` script and what it covers.

## Skills

- `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.

## Files / modules touched

- `.github/workflows/ci.yml` — the `server-integration` job.
- `08-stack-and-repo.md` §7 — update record #9 from "placeholder" to "wired to test:server".

## Acceptance

- The `server-integration` job runs `pnpm test:server` (with the cross-package build-first convention — `tsc -b` is inside the script per 08 §5.6, so the job needs only `install`), not the not-implemented echo.
- The job is a **real gate** (its failure fails the PR), matching how stage 8 is labelled in §5.6. Confirm it is not `continue-on-error` and not a green-echo stub.
- Falsify it (§2.11): a deliberately failing server test makes the job red. Watch it fail, revert.
- 08 §7 record #9 updated to reflect the wiring; the placeholder-echo path is gone (a placeholder that shadows a real suite is a fake-green — testing-guide T-11).
- No other CI job altered.
