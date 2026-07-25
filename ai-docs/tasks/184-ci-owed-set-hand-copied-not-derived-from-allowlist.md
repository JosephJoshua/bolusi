# TASK 184 — the CI "owed SEC id" set is hand-copied in THREE places and has already drifted: `ci-parity.mjs` still lists the discharged SEC-AUTH-09 while the allowlist lists only SEC-AUTH-10 — derive it from the one source

**Status:** todo
**Priority:** MEDIUM — a resurgent (regressed) SEC-AUTH-09 red is currently absorbed as OWED by the very oracle `pnpm verify` and (post-172) `pnpm ci:status` use to classify a `security-sweep` red, so it would NOT surface as a regression. Not a live failure today (SEC-AUTH-09's tests pass), but it re-arms the §2.11 stale-exemption class at the next discharge. **Do NOT hand-tighten** — that fixes today and re-creates the class; derive from the single source.
**Depends on:** 28 (which discharged SEC-AUTH-09 and updated the allowlist but not the two `ci-parity.mjs` copies), 172 (which wired the shared oracle into `ci:status`, making the drift reachable from the post-push command too)
**Blocks:** —
**SEC ids owned by THIS task:** none — but it edits the CI classification of a release-gate red, so it is §6-adjacent and MUST get its own review (see below).
**Filed by:** orchestrator on the task-172 review; the drift was seeded by the orchestrator and independently confirmed + deepened (triplication) by rev-172, 2026-07-25.

## The finding (all at ground truth, cited)
The set of SEC ids whose `security-sweep` red is "expected / owed" is maintained in **three uncoupled literals**:
- `packages/test-support/src/sec-pending-allowlist.json:3` — the LIVE keys: `["SEC-AUTH-10"]` only (SEC-AUTH-09 was discharged 2026-07-25 by task 28 and removed here). **This is the source of truth** — it is what `pnpm sec:sweep` (the actual release gate) reads.
- `scripts/ci-parity.mjs:902` — `ids: ['SEC-AUTH-09', 'SEC-AUTH-10']` on `EXPECTED.SEC_OWED_D21`.
- `scripts/ci-parity.mjs:971` — a SECOND independent literal inside `assert()`: `const owedIds = new Set(['SEC-AUTH-09', 'SEC-AUTH-10'])`.
- `scripts/ci-parity.mjs:905` — the `note:` string is doubly stale: it says "SEC-AUTH-09 leg 1 needs real SQLCipher (emulator lane only)", but SEC-AUTH-09 is discharged AND D22 removed SQLCipher entirely.

`ci-parity.mjs` does **not** import the allowlist (`grep` for it is empty) — the two `ci-parity` literals are pure hand copies, and they have drifted from the allowlist the day SEC-AUTH-09 discharged.

**Concrete failing input (rev-172 ran it):** `classifyExpectedRed(owed, <a security-sweep log whose FAIL line names SEC-AUTH-09>)` returns `owed: true`. A discharged id that REGRESSED (its titled test breaks, or the id reappears in the allowlist by mistake) would be classified OWED and exit 0 in both `pnpm verify` and `pnpm ci:status` — the exact "real failure hiding behind a permanent red" that tasks 142/172 exist to prevent, one layer down in the shared oracle.

## Deliverable — DERIVE, do not tighten (§2.8, one source of truth)
Make `scripts/ci-parity.mjs`'s owed set READ from `packages/test-support/src/sec-pending-allowlist.json` (its live keys, excluding `$comment`) rather than restating the id list. After the change there must be exactly ONE place the owed SEC id set is written; both `EXPECTED.SEC_OWED_D21.ids` and the `assert()` body consume that single derived value. Removing an id from the allowlist (the next discharge) must then propagate to `verify`/`ci:status` automatically — no second edit, no drift.
- Reconcile the stale `note` at `:905` (drop the SQLCipher clause; SEC-AUTH-09 is discharged — reference the provenance-guard discharge, not SQLCipher).
- Keep the SUBSET semantics ci-parity already documents at `:919` (a live red whose id set ⊆ the owed set is OWED; a stranger id is UNEXPECTED). Deriving the set must not change that rule.

## FALSIFY (§2.11 — REPORT it)
- **Before:** feed the shared oracle a `security-sweep` FAIL line naming SEC-AUTH-09 → confirm today's code returns OWED (the drift). This is rev-172's reproduced input.
- **After:** with the set derived from the allowlist (which no longer lists 09), the SAME input must classify UNEXPECTED — a resurgent discharged id surfaces.
- **Positive control:** the genuine current red (only SEC-AUTH-10) must still classify OWED in both `pnpm verify` and `pnpm ci:status`. Do not make the gate red on the legitimate case.
- **Derivation robustness:** an empty allowlist (both ids discharged) → the owed set is empty → ANY security-sweep red is UNEXPECTED (the gate should be green because sec:sweep itself goes green; prove the two agree). A malformed/missing allowlist → LOUD, never a silently-empty owed set treated as "nothing owed, all reds unexpected" masking a parse failure — decide and test which way it fails (fail-closed: unreadable allowlist ⇒ error, not "owe nothing").

## Note — §6-adjacent, own review (rev-172's caution)
Editing the owed set silently changes `verify`'s security classification of a release-gate red. This is exactly the kind of change that must go through its own review-wave, not ride on an unrelated diff — which is why 172 (correctly) reused the oracle verbatim and left this to a dedicated task. Cross-ref: task 166 (owed bucket scoped by id, not failure-mode) is the same class one dimension over; consider whether the derivation task and 166 should land together so the oracle is fixed once.
