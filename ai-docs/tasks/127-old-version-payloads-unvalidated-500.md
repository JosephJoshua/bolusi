# TASK 127 — task 121's gate leaves a hole below `current`: any `schemaVersion < current` skips payload validation entirely, so a malformed old-version payload is accepted at push and throws at fold as a 500 that rolls back the whole batch

**Status:** done
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


---

## ADDENDUM — 2026-07-22 adversarial sweep: worse than filed, and the fix direction changed

Reproduced on real PG16 **16.14** (Debian 16.14-1.pgdg13+1) in apps/server's own testcontainer, per-file clones of `bolusi_tmpl`, stamped by `setupPgLane` (owners `l3lane-3580852-mrvjff6f`, `l3lane-3601096-mrvji1z6`). Two peer containers were leaked on the box and **neither answered** — the stamp is what proves it (T-14d).

`notes.note_created` is the only type with `current > 1` (=3), so **v1 and v2 accept any payload at all**:

| probe | input | result |
| --- | --- | --- |
| pipeline P1 | `schemaVersion: 2`, payload `{}` | throws `null value in column "title" of relation "notes" violates not-null constraint`; op not logged |
| pipeline P2 | `schemaVersion: 2`, `mediaId: "NOT-A-UUID-AT-ALL"` | throws `invalid input syntax for type uuid` |
| HTTP-A | same via `POST /v1/sync/push` | **500 `{"error":{"code":"INTERNAL"}}`** |
| HTTP-B | `[valid v3 op, junk v2 op]` | **500**, `ops in log: 0`, good op logged: **false**, `notes` rows: `[]` |
| P2b | `schemaVersion: 1` + extra key `whateverIWant` | **accepted**, durably logged (v3's `.strict()` would reject it) |

**HTTP-B violates security-guide §4.1 literally** — "one bad op must not poison honest neighbors, except behind a `CHAIN_BROKEN` halt".

**Why this is HIGH, not MEDIUM — it permanently wedges a device.** `packages/core/src/sync/loop.ts:264-306` treats a 500 as a *transport* failure → backoff; `push.ts:104-107` keeps the ops `local`, so **the same batch is re-sent**. `backoff.ts` caps at 5 min and never stops retrying, and `failureCount` is in-memory so a restart retries immediately. One malformed op wedges that device's sync forever, and every op queued behind it never drains (05 §10: no pruning).

**Falsification already performed:** patched `deps.ts:142` to parse the declared schema → HTTP-A became `200 {status:"rejected",code:"SCHEMA_INVALID"}` and HTTP-B's honest sibling was `accepted` + logged. Reverted; baseline re-verified green.

**The fix direction has changed — do NOT just parse against the current schema.** `deps.ts`'s comment is right that validating a v2 payload against v3's `.strict()` wrongly rejects a legitimate old version. The real fix is **retained per-version payload schemas** on `OperationDeclaration` (a `payloadByVersion` map) so `resolve(type, v)` has a real schema for every foldable `v` — which is what 05 §8's wording ("Payload fails registry Zod for (`type`, **`schemaVersion`**)") already presumes. That is a **module-contract change** (`04-module-contract.md` §3): update the doc in the same commit.

A defensive applier, and converting an applier throw into a per-op rejection, are a necessary backstop (that is task **139** — the same wound from the other side) but **insufficient alone**: they still land an unvalidated payload in the append-only log.

**Honesty trap to note:** `notes-schema-version.test.ts` is green over all of this. It covers the version *boundary* (task 121's `> current` leg), never the *interior*.


---

## OUTCOME — DONE 2026-07-22 (commit merged to main; reviewed APPROVE, 0 blockers)

Retained per-version payload schemas on the module contract, fail-closed by construction: `defineModule` refuses at import time unless `payloadByVersion` covers exactly `1..schemaVersion-1`, each `.strict()`. `payloadSchemaFor` returns `undefined` (→ `SCHEMA_INVALID`, never accept) for `0`, negative, non-integer, `>current`, and any unretained version.

**Falsification, reproduced by the independent reviewer on real PG16 (own stamped lane, no peer container present):** restoring `validate: () => true` reds exactly the four reject legs of `notes-old-version-payload.test.ts` (8→4 failed) AND chaos-05 (10 failed, `TypeError` at T8) while all three positive controls (legit v1, v2, v3) stay green — the proof it is not "reject everything below current". The §4.1 honest-neighbour property is asserted on the **log and projection**, not the reply.

**chaos-05 was RED on main before this** — the reviewer checked the four touched files out at the merge-base, rebuilt, and reproduced 10/12 failed. Task 121 broke T8 outright; 127 repairs a currently-failing gate, the opposite of a test bent to fit code.

**Residuals filed as task 152** (both non-blocking, both falsified by the reviewer): the v1 schema's provenance comment cites a commit that actually contains v2 (this repo never shipped a v1 registry schema), and the import guard checks own keys while the runtime reads through the prototype.

Merge verified on the integration tree before push: server 526, harness 136, core+modules 1164, chaos-05 12/12, knip 132/29 both canaries +0/-0, lint/typecheck/i18n all green. The `knip-baseline.json` schema conflict (task 137's file-tracking) was resolved by taking main's file and regenerating via `pnpm knip:baseline` — the one new export (`payloadSchemaFor`) added from knip's own output.
