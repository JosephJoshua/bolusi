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

Two mutations, neither of which the gate noticed.

**(1) A step pointing at a file that does not exist** (impl-162):
```
BREAK:   script: bash scripts/emulator-gates.sh  ->  script: bash scripts/THIS-DOES-NOT-EXIST.sh
RUN:     npx vitest run packages/test-support/src/ci-parity.test.ts
         Test Files  1 passed (1)   Tests  16 passed (16)   EXIT_BROKEN=0
RESTORE: EXIT_RESTORED=0, 16 passed
```

**(2) A whole new undeclared step added to the job** (the 162 reviewer) — `- run: pnpm a-brand-new-uncovered-gate` inserted into `android-emulator`: still **16/16, `EXIT=0`**. This is the wider and more important half: it is not that a *path* goes unchecked, it is that **any edit anywhere in those jobs is invisible**.

Two mechanisms combine to produce it:
- `ci-parity.test.ts:264` asserts `dispatchOnly` equals `['android-emulator','ios-simulator']` and then **excludes those jobs from the plan entirely** — so their contents are never audited against anything.
- The step-count guard at `ci-parity.test.ts:141-145` counts raw step dashes on **both** sides, so adding a step increments both and **cancels out**. The one guard that could have noticed a new step is arithmetically blind to it.

The gate is green because the lane is invisible to it — CLAUDE.md §2.11's "green for the wrong reason", the i18n-catalog shape exactly.

## Why this is the interesting half of 162

162's proximate cause was `pipefail` under dash. Its *root* cause is that these lanes have no fast feedback of any kind: they cost ~20 minutes of emulator time, run only on demand, and nothing between authoring and dispatch reads them. Any typo, bad path, or shell incompatibility in those steps is discovered by a human reading a job log, or never.

## Deliverable

Give the dispatch-only lanes machine coverage that does NOT require booting an emulator.

**The structural hole is the primary deliverable, not the broken path.** A fix that only validates script paths would close mutation (1), leave mutation (2) wide open, and look green — which is this task's own failure mode reproduced.

- Extend the parity model so dispatch/schedule-gated steps are a **declared, audited bucket** rather than an absent one. Every such step needs an explicit policy entry stating *why* it cannot run locally; a step in those jobs with **no entry must fail the audit**, exactly as UNCOVERED does for push steps, and an entry naming a step that no longer exists must fail as ORPHANED. Removing `dispatchOnly`'s blanket exclusion (`ci-parity.test.ts:264`) is the point of the change.
- **Fix the step-count guard so it cannot cancel out** (`ci-parity.test.ts:141-145`). Counting raw dashes on both sides means any added step increments both. Count the *audited* set against the *declared* set, or assert per-job counts.
- **Statically check what is checkable**: every `run:`/`script:` invoking a repo file (`bash scripts/x.sh`, `node scripts/y.mjs`) must reference a path that EXISTS and is executable. This closes mutation (1) only — necessary, not sufficient.
- Lint the shell in those lanes (`shellcheck` on `scripts/*.sh`, plus `bash -n`). `shellcheck` is **not installed** on the dev host today — a CI step or a documented install is part of this.
- Consider `actionlint` for the workflow as a whole (also not installed locally).

## FALSIFY (§2.11 — REPORT it, do not assert it)

**The acceptance mutation is (2), the added step — not (1).** Both must red:

- **Primary:** insert `- run: pnpm a-brand-new-uncovered-gate` into `android-emulator` (and separately into `ios-simulator`) with no policy entry. The gate must go **RED** naming that step. Restore, confirm green. Paste both exits. Today this is `16/16, EXIT=0`.
- **Secondary:** point a `script:`/`run:` at a nonexistent repo file. Must also red.
- **Third, the inverse:** delete a dispatch-only step that HAS a policy entry — the entry must red as ORPHANED. A bucket that only catches additions is half a gate.
- **Denominator floor (T-14):** assert the audited dispatch-only step count is `> 0` and matches the jobs on disk. A bucket that silently audits **zero** steps passes every mutation above while checking nothing — the exact trap this task documents.
- State plainly whether `shellcheck`/`actionlint` actually ran or were merely configured — "typed and compiling" is not "running".
