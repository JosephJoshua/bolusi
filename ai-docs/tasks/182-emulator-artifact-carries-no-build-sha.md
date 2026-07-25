# TASK 182 — the emulator gate artifact carries no self-declared build sha, so the SEC-AUTH-09 provenance guard binds to git history, not to the code it certifies

**Status:** todo
**Priority:** MEDIUM — hardening. The accidental-staleness case (a dev regresses the seal and forgets to re-run the emulator) IS closed by task 28's provenance guard (`AT_REST_SURFACE` freshness diff). This closes the residual it could not: a deliberately-committed FABRICATED artifact.
**Depends on:** 28 (the SEC-AUTH-09 discharge + provenance guard), 175/178 (the emulator producer).
**Blocks:** —
**SEC ids owned by THIS task:** none (hardens SEC-AUTH-09's discharge evidence).
**Filed by:** orchestrator, 2026-07-25, on the SEC-AUTH-09 discharge review (impl-28-sec09 + rev-28-sec09 both surfaced it).

## The residual
`reports/device-gates/YYYY-MM-DD-emulator.json` (`bolusi-harness-result/1`) records `target`, `variant`,
a timestamp-based `runId`, and per-gate verdicts — but **no build sha**. So the SEC-AUTH-09 discharge
gate (`packages/harness/src/security/device-gate-provenance.ts`) can only anchor on *where the artifact
sits in git history* (its introducing commit) and diff the at-rest surface against it. rev-28-sec09
proved the limit empirically: a **fabricated NEW artifact file** (leg1=pass, plausible runId) committed
cleanly, with `DEVICE_GATE_ARTIFACT` repointed at it, makes the gate GREEN. The git-history scheme
cannot tell a real emulator run from a forged one.

Judged ACCEPTABLE for the discharge because it requires a deliberate malicious insider forging a build
artifact AND a review-visible constant-repoint diff — a strictly higher threat class than the
accidental staleness the guard closes. But it is a real gap, honestly recorded in the module header,
the allowlist `$comment`, and task 28.

## Deliverable
Have the emulator producer record the BUILD SHA inside the artifact, and have the provenance guard
prefer it:
1. The gate script (`scripts/emulator-gates.sh` / `scripts/harness-device.mjs`) or the on-device
   harness stamps the artifact with the git sha the APK was built from (available in the CI checkout —
   `GITHUB_SHA` / `git rev-parse HEAD`). Put it in the `bolusi-harness-result/1` schema (bump the schema
   or add a field) so it is part of the emitted, tamper-evident document, not added afterward.
2. `device-gate-provenance.ts` prefers the self-declared sha when present: the freshness diff runs
   against THAT sha (the commit the emulator actually built), not just the file's introducing commit.
   A fabricated artifact would now have to name a real sha whose tree matches — much harder to forge
   silently.
3. Keep the git-history anchor as a fallback / cross-check (belt and braces), and keep the
   working-tree-≠-committed check.

## FALSIFY (§2.11)
- A fabricated new artifact naming a sha whose at-rest surface differs from HEAD → the gate must RED
  (the current residual's exact case, now closed).
- A real artifact whose declared sha matches → green (positive control; don't break the real path).
- The accidental-staleness case (task 28's) must still RED — this must not regress the guard 28 shipped.

## Note
The producer stamping the sha ALSO makes the artifact self-describing for the SEC-AUTH-10 physical-device
benchmark (task 27) when that lands — same schema, same provenance discipline. Coordinate the schema
bump once.
