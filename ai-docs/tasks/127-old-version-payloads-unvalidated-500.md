# TASK 127 — task 121's gate leaves a hole below `current`: any `schemaVersion < current` skips payload validation entirely, so a malformed old-version payload is accepted at push and throws at fold as a 500 that rolls back the whole batch

**Status:** todo
**Priority:** **HIGH — same accept-then-throw-at-fold class task 121 closed, still open on the old-version branch.** Reachable by any enrolled device (it signs its own op, so the signature step passes). The failure is a `500 INTERNAL` that rolls back the ENTIRE push batch, not a per-op rejection — so one malformed op poisons a whole sync.
**Depends on:** 121 (the gate this completes), 07, 11
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** QA spec-verify sweep, 2026-07-22.

## The finding (verified by the orchestrator)

`apps/server/src/deps.ts`:
```ts
if (schemaVersion !== currentVersion) {
  return { kind: 'known', validate: () => true };   // <-- no validation at all
}
```
Task 121 correctly accepts `1..current` as foldable and rejects `> current` / non-integer. But for a version BELOW current it returns `validate: () => true`, so the payload is never checked. The chain:
1. `deps.ts` — old version ⇒ `validate: () => true`
2. `oplog/steps/schema.ts:13` — `resolution.validate(payload) ? null : 'SCHEMA_INVALID'` ⇒ always `null`
3. `oplog/pipeline.ts:261-263` — the applier throw is re-thrown (only `isUniqueViolation` is caught) and "propagates out of `forTenant`, rolling back this op AND the whole batch"
4. `app.ts:96` — a non-`ApiError` ⇒ `respondError(c, 'INTERNAL')` = **500**

**Measured** (QA probe, modules lane, real appliers/engine): a v1 op with `{}` threw `DbError: NOT NULL constraint failed: notes.title`; a v2 op with junk threw `DbError: Too few parameter values were provided`. Both produced zero rows. The applier throw is measured; the 500 is code-traced (the prober deliberately did not stand up PG — see the provenance note below).

**121's comment is honest about the cause** ("the registry retains only the CURRENT payload schema … per-version payload schemas would be a module-contract change, out of this task's scope") — the gap is that the *consequence* was never stated or tested. `notes-schema-version.test.ts` has three cases; the `validate: () => true` branch has **no adversarial case at all**.

## Deliverable
- Close the branch so a malformed OLD-version payload is rejected at push (per-op `SCHEMA_INVALID`, 05 §8), never a 500/batch rollback. Most likely: per-version payload schemas in the registry (a deliberate module-contract change — cite 04 §3), or a fold-safety pre-check. Do NOT "fix" it by rejecting legitimate old versions (task 121's nuance still holds: a rolling-out v2 client must keep working).
- **Falsify (§2.11, real PG16, attributed T-14d):** push a well-formed-envelope op at `schemaVersion: 2` whose PAYLOAD is malformed → BEFORE: 500 + the batch rolled back. AFTER: per-op `SCHEMA_INVALID`, the rest of the batch still applies, op absent from the log. Break the fix → the 500 returns → restore. Positive controls: a legitimate v2 payload still accepts and folds; current v3 unaffected.

## Provenance note (read before reproducing)
Two leaked Postgres containers from other worktrees were found running during this sweep (the §2.11 "a number served by another worktree's container" hazard) and have since been removed. Anyone reproducing this on PG must assert the container's own provenance (T-14d).
