# TASK 163 — the dispatch-only CI lanes (`android-emulator`, `ios-simulator`) are invisible to every local gate: a step there can be nonsense and everything stays green

**Status:** todo
**Priority:** MEDIUM-HIGH process — this is the blind spot that let task 162 live. An emulator step that had **never executed a single assertion** survived authoring, review, and every `pnpm verify` / drift-gate run, and was only found by reading a dispatched job log by hand.
**Depends on:** 142 (the parity model this extends), 162 (which demonstrated the gap)
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** impl-162, 2026-07-23, from the falsification of the 142 drift gate against the emulator lane.

## The finding

`scripts/ci-parity.mjs` builds `STEP_POLICY` over **push-triggered** steps only, and `packages/test-support/src/ci-parity.test.ts` audits that set. Both `android-emulator` and `ios-simulator` are gated behind
`if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'`, so **neither is in the audited set at all**. Their steps are UNCOVERED by construction, not by oversight — and the audit does not say so.

Watched it go red — it didn't:

```
BREAK:   script: bash scripts/emulator-gates.sh  ->  script: bash scripts/THIS-DOES-NOT-EXIST.sh
RUN:     npx vitest run packages/test-support/src/ci-parity.test.ts
         Test Files  1 passed (1)
         Tests  16 passed (16)
EXIT_BROKEN=0
RESTORE: EXIT_RESTORED=0, 16 passed
```

A step pointing at a **file that does not exist** changed nothing. The gate is green because the lane is invisible to it, which is CLAUDE.md §2.11's "green for the wrong reason", the i18n-catalog shape exactly.

## Why this is the interesting half of 162

162's proximate cause was `pipefail` under dash. Its *root* cause is that these lanes have no fast feedback of any kind: they cost ~20 minutes of emulator time, run only on demand, and nothing between authoring and dispatch reads them. Any typo, bad path, or shell incompatibility in those steps is discovered by a human reading a job log, or never.

## Deliverable

Give the dispatch-only lanes machine coverage that does NOT require booting an emulator. Sketch (pick what holds; do not over-build):

- Extend the parity model so dispatch/schedule-gated steps are a **declared, audited bucket** rather than an absent one — every such step needs an explicit policy entry stating *why* it cannot run locally. A new step in those jobs with no entry must fail the audit, exactly as UNCOVERED does for push steps.
- **Statically check what is checkable**: every `run:`/`script:` that invokes a repo file (`bash scripts/x.sh`, `node scripts/y.mjs`) must reference a path that EXISTS and is executable. That single rule would have caught the broken-path mutation above.
- Lint the shell in those lanes (`shellcheck` on `scripts/*.sh`, plus `bash -n`). Note `shellcheck` is **not installed** on the dev host today — a CI step or a documented install is part of this.
- Consider `actionlint` for the workflow as a whole (also not installed locally).

## FALSIFY (§2.11 — REPORT it, do not assert it)

- Re-run the exact mutation above (`script:` → a nonexistent path) and confirm the new gate goes **RED**, then restore and confirm green. Paste both exits. That mutation is the acceptance test — it is the one this task exists to catch.
- Add a second mutation the first cannot see (e.g. a dispatch-only step deleted outright, or a new one added with no policy entry) and confirm it also reds. **Test the class, not the instance.**
- State plainly whether `shellcheck`/`actionlint` actually ran or were merely configured — "typed and compiling" is not "running".
