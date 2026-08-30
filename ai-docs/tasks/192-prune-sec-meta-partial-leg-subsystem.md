# TASK 192 — prune the near-empty partial-leg subsystem in sec-meta; keep SEC-META-01 intact

**Depends on:** 189
**Blocks:** —
**SEC ids owned by THIS task:** none (this task does not add or retitle a SEC id; it simplifies the parser that reads them).

**Filed by:** the 2026-08-30 complexity/over-engineering audit (owner-approved cut-list, Tier 2 #5).

## Goal

`packages/test-support/src/sec-meta.ts` (515) + `sec-meta.test.ts` (419) implement a **partial-leg / arm / precursor / partial** title-word subsystem for SEC-id ownership. But the **live SEC allowlist = 1 entry** (SEC-AUTH-10) and the **invariant allowlist = 0** — the machinery guards a near-empty denominator. Prune the partial-leg word-matching branches that no live id uses; keep the minimal SEC-META-01 ownership check and the single live entry.

## Must preserve (do NOT cut — this is a real, incident-earned security-doc gate)

- **SEC-META-01**: every security-guide SEC id without a shipped test maps to its owning task's marker line. This caught the "**mention ≠ ownership**" bug and the "task disclaiming an id satisfied it" bug (memory: `bolusi-sec-id-authoring-gates`, and CLAUDE.md §2.11's `badOwners` story).
- `parseOwnedIds`' **BARE-id-list** rule — the owner marker must be a bare id list; trailing prose is rejected.
- The one **live allowlist entry** (`SEC-AUTH-10` → task 27) — do NOT green it; it stays owed per D21.

## Scope boundary

This task touches **only** `sec-meta.ts` / `sec-meta.test.ts` (the owner-side parser). The **second** SEC-id parser (the OWED-id set in `ci-parity.mjs` / `sec-sweep.mjs`, hand-copied in 3 places per task 184) lives in **task 194's gated CI files** — do not touch it here; 194 derives it from the allowlist. Cross-referenced, not merged, to keep 192 ungated.

## §6 note (security surface, but NOT a gate move)

Simplifying a SEC parser is a security surface → **ships adversarial tests before review (§2.5)** and gets owner-aware review. It does **not** weaken SEC-META-01's guarantee (same check, fewer dead branches) and does **not** move a gate — so, unlike task 194, it needs no owner sign-off. Re-falsify every trap the memory records.

## Docs to read

- `ai-docs/security-guide.md` §2.1.4-5; CLAUDE.md §2.11 (`badOwners`, sec-meta stories); memory `bolusi-sec-id-authoring-gates`.

## Files / modules touched

- `packages/test-support/src/sec-meta.ts`, `sec-meta.test.ts`. (Serialize with task 189 — both touch the test-support SEC area / `sec-pending-allowlist.json`.)

## Acceptance

- One SEC-id owner parser, no partial-leg word-matching for an empty set, SEC-META-01 unchanged in behaviour.

### Falsification (§2.11 — re-run the memory-recorded traps against the pruned parser)

1. A task that names a SEC id **only to disclaim it** must still **red** (the `badOwners`-matched-a-mention bug must stay dead).
2. An owner marker with **trailing prose** must still be **rejected** by `parseOwnedIds`.
3. An id that is **both titled and allowlisted** must still **red** (row and title cannot both be true).
4. Leg / arm / precursor / partial **title words** must not sneak an untitled id past the gate.
Break each, observe the specific red, restore, observe green — report the falsification, not "tests pass."
