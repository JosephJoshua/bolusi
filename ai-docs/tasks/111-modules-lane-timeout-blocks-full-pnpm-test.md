# TASK 111 — `packages/modules` is a THIRD load-flake lane (task 93's triage mis-classified it), and it currently blocks a green full `pnpm test`

**Status:** in-progress
**Priority:** **MEDIUM** — this is the one lane in the class that is failing TODAY, not pre-emptively: `packages/modules/test/applier-conformance.test.ts` reds `Test timed out in 5000ms` **3/3 at only 2× oversubscription** (96 spinners, loadavg 34–73), and failed at 6321ms inside a real full-suite run. Because of it, **`pnpm test` (full monorepo) cannot currently go green under load** — pre-existing, NOT caused by task 93 (verified by stashing task 93's change and reproducing the identical red).
**Depends on:** 93
**Blocks:** — (but it blocks any acceptance line that says "full `pnpm test` green")
**SEC ids owned by THIS task:** none

## The finding (task 93, measured — not guessed)

`packages/modules/vitest.config.ts` is still on the default **5000ms**. Its `applier-conformance.test.ts` ("the same op script folds to byte-identical oracle digests on both engines") does **~4.08s of real work idle** — both a better-sqlite3 AND a PGlite engine, full migrations, a real op script, two folds, digest comparison. So the margin is **~900ms**, the thinnest in the repo.

**Task 93's own triage listed `modules` under "not candidates."** That triage was wrong: it classified by PACKAGE rather than by what the test BODY actually does (task 93's author saw "modules = pure module logic" and missed that the conformance test drives two real DB engines). The lesson generalises — the class is defined by *real I/O under parallel load*, not by which package a file lives in.

## Acceptance

- Apply the SAME measured derivation task 67/93 used (do not copy a number blindly): measure `applier-conformance` idle and under load (state the maxima), derive the timeout, and set it in `packages/modules/vitest.config.ts` with a comment recording the measurement — matching the 20000ms repo-wide starvation margin if the measurement supports it.
- **Falsify (§2.11):** break what the conformance test protects (e.g. make one engine's applier write a different value) → it must fail FAST on a real assertion (a digest mismatch), NOT by timeout — proving the longer bound masks nothing. Report the observed failure text + duration.
- **Re-sweep the class by test BODY, not by package** (T-12): any test doing real DB/subprocess/crypto work under parallel load is a candidate. State the denominator (files inspected) and what you excluded and why. Fix any other genuine member found, or file it.
- **Then verify the thing that is currently impossible:** a full `pnpm test` green (this lane is the known blocker). If it still cannot pass, say exactly what fails, with output — do not report a partial run as a full green (§2.1).

## Note
Filed from task 93. Worth carrying: task 93 found this only because it ran the FULL suite rather than trusting its own task file's triage — and then reported that the full suite was already red for a reason outside its scope, instead of quietly scoping around it. Note also the sibling trap task 104 found: `pnpm --filter @bolusi/eslint-config test` exits **0 having run nothing** (no `test` script; tests run from the root via `--project`), so any "run the package's tests" instruction can self-certify — prefer `--project <name>` or add the missing script.
