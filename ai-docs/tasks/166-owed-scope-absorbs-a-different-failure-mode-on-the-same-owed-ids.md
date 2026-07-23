# TASK 166 — the OWED bucket now scopes by ID, but not by FAILURE MODE: a different SEC-inventory failure that happens to name only SEC-AUTH-09/10 is still absorbed as "expected"

**Status:** todo
**Priority:** LOW — narrower than 154 (it needs a new inventory failure that names ONLY the two owed ids and no others) and self-closing the day SEC-AUTH-09/10 discharge. Filed because it is the same class as 142 and 154, one level down again, and because the next person to read `assert()` should find it recorded rather than rediscover it.
**Depends on:** 154
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** the task-154 implementer, 2026-07-23, by falsifying the tightened `EXPECTED.SEC_OWED_D21.assert()` immediately after building it.

## The finding (demonstrated, not hypothetical)
Task 154 tightened `assert()` from "the only red STEP is `SEC inventory…`" to "…and every id in that step's `FAIL` lines is ⊆ {SEC-AUTH-09, SEC-AUTH-10}". That closes a new id appearing. It does **not** close a **new failure MODE on an id already in the owed set**.

`scripts/sec-inventory.mjs` can red an owed id for a reason that is not "this id is owed". Falsified input — the real pending-allowlist line plus one more, both naming only owed ids:

```
── SEC inventory (security-guide §2.1.4 / §12) — EXIT=1
FAIL SEC-AUTH-09 is on the pending allowlist (owed by ai-docs/tasks/28-security-sweep.md) but a test titles it — the row and the title cannot both be true
FAIL the SEC pending allowlist is NOT empty — the release gate cannot pass while ids are owed: SEC-AUTH-09 → …, SEC-AUTH-10 → …
```

→ `assert` returns `{ok:true}` = **OWED**. But the first line is a genuine bookkeeping regression the allowlist's own `$comment` calls out ("the row and the title cannot both be true") — the exact situation that arises if task 27a ships a test titling SEC-AUTH-09 and nobody removes the allowlist row. The gate would report it as red-by-design.

## Why it was left open by 154, deliberately
The obvious tightening — pin the accepted FAIL line to the pending-allowlist wording — couples the exemption to `sec-inventory.mjs`'s **prose**. A wording edit there would then turn today's legitimate owed-red into a false UNEXPECTED, and an exemption that cries wolf is re-ignored, which is the disease `pnpm verify` exists to treat. 154's own positive control exists to prevent exactly that. So the fix here needs a **structural** discriminator, not a string match.

## Deliverable (sketch, not a mandate)
Give `sec-inventory.mjs` a machine-readable failure **code** per failure (e.g. `FAIL [PENDING_ALLOWLIST_NON_EMPTY] …`, `FAIL [ALLOWLISTED_BUT_TITLED] …`, `FAIL [NO_PASSING_TEST] …`) and have the owed entry accept a code+id pair rather than an id alone. That makes the exemption's scope explicit in both files and survives prose edits. Whatever is chosen, keep 154's rules: an unrecognised code is UNEXPECTED, and "matched no code" is a LOUD failure, never a silent pass.

## SEE ALSO — the same shape, one lane over (task "dispatch-only CI lanes have no machine coverage")
Independently found by the task-162 reviewer, in the same file this task touches. `ci-parity.test.ts`
asserts `dispatchOnly` equals `['android-emulator','ios-simulator']` and then excludes those jobs from
the plan **entirely**, so any edit inside them is invisible: the reviewer added a whole new undeclared
`- run: pnpm a-brand-new-uncovered-gate` step to `android-emulator` and `ci-parity` still passed
**16/16, EXIT=0**. The step-count guard does not catch it either — it counts raw step dashes on both
sides, so an added step increments both and cancels.

## THE CLASS — four instances now, and none of them is about SEC or about emulators

> The OWED / exclusion machinery scopes what it exempts **by name**, not by **what the exemption is
> actually licensing**.

| where | what IS scoped | what is NOT |
| ----- | -------------- | ----------- |
| task 154 (fixed) | the failing STEP is the SEC inventory | *which ids* it is red for |
| **this task** | the failing IDS are the owed ones | *which failure mode* those ids are red for |
| task 172 | the failing JOB is `security-sweep` | *anything about why* — `assert()` is never called |
| task 163 (dispatch-only lanes) | the JOBS no local command reproduces | *their entire contents* |

Task 172 is the one to read first: it is the same hole as this file's, unclosed, in `ci:status` — the
command run after every push — because that command reads the `gh` job-list API and so has no log text
to call `assert()` against. Task 163 is the same shape one file over: `dispatchOnly` names the jobs
nothing local reproduces and thereby stops inspecting them at all, which is how a whole new undeclared
step passed 16/16. Fixing any one in isolation leaves the class open.

(163 and 172 are the ids at time of writing; this range was allocated concurrently across branches and
numbers have already collided once — match by slug, not by number.)

## FALSIFY (§2.11 — REPORT it)
- Reproduce the input above and confirm it returns OWED **before** changing anything (it does today).
- After the fix it must return UNEXPECTED and name the failure mode, not just the id.
- **Positive control:** the real current output (CI run 29949061877 / job 89021942509, transcribed verbatim in `packages/test-support/src/ci-parity.test.ts`) must still return OWED.
- Re-falsify the "found nothing to parse" branches — a code-aware parse is a new oracle with the same blindness risk 154 documented (its start-anchored near-miss is recorded in that file's comment).
