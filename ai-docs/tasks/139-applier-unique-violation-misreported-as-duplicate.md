# TASK 139 — a projection applier's unique violation is misreported as `duplicate`: the op VANISHES from the append-only log, the client is told "synced", and the chain head desyncs into a permanent `CHAIN_BROKEN` brick

**Status:** in-progress
**Priority:** **HIGH — data loss + a permanent client brick.** An op is neither accepted-and-logged nor rejected-and-reported. 05 §1 says the log is append-only; this silently drops from it.
**Depends on:** 114 (whose `isUniqueViolation` mapping this narrows)
**Blocks:** —
**SEC ids owned by THIS task:** none, but it sits on the op-log integrity surface — read `security-guide.md` §2.2 before changing the classification, because the *reason* the catch exists is to avoid confirming a foreign op id.
**Filed by:** QA adversarial sweep, 2026-07-22 (site verified by the orchestrator).

## The finding

`apps/server/src/oplog/pipeline.ts:244-269`. `projectionEngine.applyPulledOp(op)` (line **261**) sits **inside** the `SAVEPOINT op_write` try whose catch (line **263**) maps **any** `23505` to `duplicate`. The comment at 240-242 asserts *"Any OTHER unique violation is unreachable on this branch"* and enumerates dedupe / chain / counter — **it omits the applier**, which runs arbitrary module SQL. Another instance of §2.11's "the comment was the guard".

**Reproduction (HTTP-C, real PG16 16.14, apps/server's own stamped testcontainer):** two **distinct**, correctly-chained, correctly-signed v3 `note_created` ops sharing one `entityId`:

```
distinct op ids: true  0191dd9d-efe9-7f70-…  0191dd9d-f3d2-7088-…
status: 200 {"results":[{"…efe9…","status":"accepted","serverSeq":1},
                        {"…f3d2…","status":"duplicate"}]}
ops in log: [{"id":"…efe9…","serverSeq":"1"}]     ← op2 absent
op2 durably logged: false
device lastSeq: {"lastSeq":"1"}                    ← head never advanced past op1
```

**Why it is illegitimate.** api/01 §3 maps `duplicate` → **`synced`** on the client (`packages/core/src/sync/push.ts:180-186`: "`accepted` + `duplicate` — both terminal-success"), so the device is told a lie. The head divergence then makes the device's *next* op (`seq 3`, `previousHash = op2.hash`) a **`CHAIN_BROKEN`** → `pushHalted` (05 §8: "surface loudly; halt push; require investigation"). A silent misclassification becomes a permanent brick.

**Falsification already performed:** added an `inApply` flag so an apply-step 23505 re-throws → HTTP-C became a loud 500, `ops in log: []`, `device lastSeq: 0` — proving the `duplicate` classification is produced by `applyPulledOp` being inside that catch. Reverted.

## Deliverable
Narrow the catch to the two statements it was written for: `allocateServerSeq` + `insertOperationRow` in their own try; `applyPulledOp` **after** it (still inside the savepoint) with its throw propagating. Harden further by identifying the real duplicate on **`err.constraint === 'operations_pkey'`** rather than SQLSTATE alone, so the catch cannot silently widen again when a new statement is added between them. Then fix the 240-242 comment to describe what the code now does.

Note the interaction with task 127: an applier throw propagating is *loud*, which is right — but 127 must land so that a **malformed payload** is rejected per-op rather than reaching the applier at all. Sequence 139 after 127, or coordinate.

## FALSIFY (§2.11 — REPORT it, real PG16, attributed T-14d)
- Reproduce HTTP-C first and lead with the `duplicate` + `op2 durably logged: false` output. After the fix, the second op must be **reported**, not vanish — decide and state which of `rejected` (with a code) or a loud failure the specs require, and cite the line.
- **Positive control:** a genuine same-op-id replay still returns `duplicate` and still does NOT 500 (that is task 114's property; do not regress it). And a genuine cross-tenant op-id collision still returns `duplicate`, not a 500 that would confirm the id exists (security-guide §2.2).
- Break the narrowed catch (widen it back) → the new test reds. Restore → green.

## Constraints
`pipeline.ts` is contended — serialize with 127/134. Do not change what `duplicate` means on the wire (api/01 §3). Do not touch the projection engine.
