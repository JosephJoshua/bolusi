# TASK 154 — the OWED bucket asserts scope at the STEP level but not WITHIN the SEC-inventory step, so a new inventory-level SEC regression coexisting with the still-pending 09/10 is absorbed as "expected"

**Status:** done
**Priority:** MEDIUM — this is task 142's own "hide behind a permanent red" pattern, recreated one level down, inside the gate built to prevent it. Narrow (only SEC-inventory *bookkeeping* regressions that don't also red a test lane) and self-closing (it disappears the day SEC-AUTH-09/10 discharge), but real and demonstrated.
**Depends on:** 142 (merged 2026-07-22)
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** the task-142 reviewer, 2026-07-22, by falsifying `EXPECTED.SEC_OWED_D21.assert()` directly.

## The finding (demonstrated, not hypothetical)
`ci-parity.mjs`'s OWED assert requires (a) the only failing `sec:sweep` summary step is `SEC inventory…` and (b) `SEC-AUTH-09`/`SEC-AUTH-10` appear in the output. It does **not** verify the inventory's failing id set is *exactly* {09, 10}.

Falsified input: a summary with only `EXIT=1  SEC inventory`, plus `FAIL SEC-AUTH-09 is pending`, `FAIL SEC-AUTH-10 is pending`, **and a fabricated `FAIL SEC-META-01 has no passing test`** → `assert` returns `{ok:true}` = **OWED**. A new SEC-inventory-level regression that coexists with the still-pending 09/10 is absorbed.

## Scope of the hole (why MEDIUM, not HIGH)
- A SEC test that *fails* still surfaces as a **test-lane** red → caught as UNEXPECTED (the F4 path). Absorbed only are inventory **bookkeeping** regressions that do not also red a test lane: a SEC test *deleted or renamed* (its id loses its only passing test), a new roll-up SEC id declared with no test, or a new pending-allowlist entry added silently.
- It **self-closes**: once SEC-AUTH-09/10 are discharged, `sec:sweep` goes green and any residual inventory red → UNEXPECTED automatically.

## Deliverable
Have `assert` parse the SEC-inventory step's own `FAIL SEC-…` lines and require the failing SEC-id set **⊆ {SEC-AUTH-09, SEC-AUTH-10}** — the ids are already in the output, so no new data source is needed. Anything else in that set → UNEXPECTED.

## FALSIFY (§2.11 — REPORT it)
- Reproduce the reviewer's absorbed input first (09 + 10 + a fabricated third FAIL) and confirm it currently returns OWED. After the fix it must return UNEXPECTED naming the third id.
- **Positive control:** the genuine current state (only 09 + 10 failing) still returns OWED, EXIT the reader expects — the fix must not turn today's legitimate owed-red into a false UNEXPECTED, or `ci:status` becomes noise and gets ignored.
- Falsify the new parse itself before trusting it (it is a new oracle — T-14b).

## Two minor findings from the same review (fold in or note)
1. **LOW** — `checkToolchain()` treats a missing `gitleaks` as a hard PROBLEM, so `pnpm verify` (fast) reds on a dev machine without gitleaks even though the only gitleaks-dependent step (`pnpm test`) is full-tier/deferred. Over-strict for the per-commit tier — demote to a note in fast tier, or gate the check on whether a gitleaks-dependent step is actually in the plan.
2. **INFO** — `ci:status` reads `--branch main`'s recent runs but does not correlate to a specific pushed SHA, so it answers "is main's recent CI clean" not "did CI run *my* commit." Acceptable for the merge-discipline use, but state it in the command's own output so no one over-reads it.
