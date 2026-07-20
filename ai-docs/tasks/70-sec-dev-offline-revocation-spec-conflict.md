# TASK 70 — SEC-DEV-04's §218 cannot be built as written: it contradicts api/02-auth §7.3 and asks for a result the wire never produces

**Status:** done

> **OWNER RULING (2026-07-17):** RULED: §218 is over-specified (D18). Drop 'kept + surfaced as rejected'; the guarantee is wiped-not-leaked, matching §7.3. Edit the guide, then retire SEC-DEV-04 honestly.

**ESCALATED (review-61):** §218 vs §7.3 is a real spec contradiction requiring a §6 owner decision, not an implementer's call — see OPEN-QUESTIONS.
**Priority:** **HIGH** — a REQUIRED adversarial test whose spec is self-contradictory. Until this is resolved, SEC-DEV-04 cannot be honestly retired by anyone.
**Depends on:** —
**Blocks:** 28 (its roll-up requires the allowlist EMPTY, which requires these two ids resolved)
**SEC ids owned by THIS task:** SEC-DEV-07

## Where this came from

Task 61 was filed to ship SEC-DEV-04's client leg, on the finding that a `(server leg)` title had retired the id with no allowlist row. **The gate half of that was true and is now fixed** (task 61 closed it). **The "just ship the client leg" half died on contact with the spec**, exactly as task 54's did — and for the same reason: nobody had traced the requirement to a producer before believing it.

Task 61 shipped the three behaviours that are real (`packages/core/test/sync/offline-revocation.test.ts`) and left the id allowlisted here, because two of the five **cannot be built as written**.

## The finding — reproduced, not reasoned about (task 61, 2026-07-15)

security-guide §218 (SEC-DEV-04, "offline-revocation caveat holds") requires five behaviours. A reproduction drove the real `SyncLoop` through offline → revoked → reconnect against the real client DB, real migrations, real signatures:

| # | §218 requires | what actually happens | |
| - | ------------- | --------------------- | - |
| 1 | "continues local operation" | `loopState: 'backoff'`, `syncDisabled: 0`, ops append and queue fine | **holds** |
| 2 | "on reconnect, all queued ops → `DEVICE_REVOKED`" | ops are `{status: 'local', code: null}` — **no marking at all** | **never happens** |
| 3 | "kept" | 3 op rows survive | **holds** (as `local`, not `rejected`) |
| 4 | "surfaced as `rejected`" | `surfacedOpRejected: 0`, `surfacedSyncDisabled: 1` | **never happens** |
| 5 | "none accepted" | `pushesAttempted: 2`, nothing accepted | **holds** |

### Why 2 and 4 are unreachable — three independent, spec-level reasons

1. **The wire never produces the result §218 wants.** A revoked token 401s at the auth middleware (`apps/server/src/middleware/auth.ts:115`), which is normative, not incidental: api/02-auth §8 (`:465`) *"A revoked device → `DEVICE_REVOKED`"* and the §9 table (`:492`) *"401 | `DEVICE_REVOKED` | Token of a revoked device"*. Every `/v1` route sits behind it (`apps/server/src/app.ts:99`). The per-op `DEVICE_REVOKED` results §218 asks for are produced **only** by `apps/server/src/oplog/pipeline.ts:91`, which is **behind that middleware** and therefore unreachable over HTTP for a revoked device. `apps/server/test/integration/sync/sec-sync.test.ts:67` proves the wire truth: push and pull by a revoked device → **401**, handler never runs.
2. **The client has no path from a 401 to op marking.** `markSyncResult` is called from `push.ts` only, on a 200 `PushResponse`. A 401 is a *cycle failure* (`loop.ts:277`) → sync disabled. Verified: `markSyncResult` has exactly one caller file.
3. **"kept + surfaced as `rejected`" contradicts api/02-auth §7.3 outright.** §7.3 is explicit that a confirmed `DEVICE_REVOKED` **wipes the device**: *"Unsynced ops and media are destroyed with the rest — **by design**; the mitigation for that loss is sync frequency, not wipe reluctance."* An op cannot be both destroyed by design and kept-and-surfaced as its steady state.

### And building it anyway would be a defect, not a fix

`rejected` is **terminal** (03-state-machines §3). Marking queued ops `rejected` on a 401 would let **one spurious 401 permanently destroy a device's unsynced work** — precisely the outcome §7.3's confirm-then-wipe step exists to prevent (*"a single spurious 401 must never wipe a fleet"*). Any resolution that "just makes the test pass" by marking ops rejected on a 401 is **weakening a data-safety control** (CLAUDE.md §6) and must not be taken without an explicit decision.

## Decide (red-flag call — CLAUDE.md §6; spec change, so it is this task's, not an implementer's)

**Which is wrong, §218 or the system?** Pick one and record it in `decisions/`:

- **(a) §218 is over-specified** — most likely. The behaviours that carry the security weight are 1, 3 and 5 (the caveat is honest; nothing the revoked device did gets in), and they hold and are now proven. Rewrite §218's row to describe the 401 path — *"on reconnect → `401 DEVICE_REVOKED`; queued ops kept, none accepted; revocation surfaced (`syncDisabled`/`device_revoked`) and §7.3's confirm-then-wipe is the terminal step"* — and retire the id against the shipped test by titling it there.
- **(b) §218 describes the revocation-**window**, not the offline path** — in which case it is a duplicate of SEC-SYNC-02, whose client leg already ships (`packages/core/test/sync/push.test.ts:259` — per-op `DEVICE_REVOKED` → `rejected`, kept, surfaced). Then SEC-DEV-04 should be **removed** from the guide as redundant, or explicitly scoped to the offline half only.
- **(c) The system is wrong** — the server should let a revoked device's push reach the pipeline and answer `200` + per-op `DEVICE_REVOKED`, so the client can mark and surface. This contradicts api/02-auth §8/§9 and gains nothing (the ops are wiped moments later by §7.3). Requires changing normative auth spec. Lowest-value; state plainly why if chosen.

**Whatever is chosen, the `pipeline.ts:91` question stands on its own:** it is a correct, defensive branch whose only reachable caller is a test (`pipeline.test.ts:262` calls `processPushBatch` directly). It is sound as defence-in-depth for a revoke landing mid-request — but it is *not* the offline-reconnect path, and it should not be cited as SEC-DEV-04's producer. (Cousin of task 60's "11 sound tests, zero callers".)

## SEC-DEV-07 — the same shape, found by the same sweep

`13-auth-server.md:63` disclaims SEC-DEV-07's other leg **in prose**: *"the CHAIN_BROKEN-generation leg is task 07's."* **Task 07 does not own it** — `07-oplog-server.md:55` claims only `SEC-OPLOG-01..09`. So the leg was pointed at a task that never accepted it, and the `(surfacing leg)` title retired the whole id with no allowlist row. The 17th instance of the class, and the third in one file.

Its title no longer carries the id (task 61), so the id is allowlisted here. **Decide whether it is already covered:** §221 wants *"forge an op with correct signature but stale chain state → `CHAIN_BROKEN` + `device_anomalies` row … surfaced in `GET /v1/devices` anomaly counts"*.

- The **generation** leg looks materially covered by `apps/server/test/integration/oplog/sec-oplog.test.ts:241` (`breakPreviousHash` re-signs with the device's REAL key → `CHAIN_BROKEN` + a `CHAIN_BROKEN` anomaly row) — which is exactly "correct signature, stale chain state". It is titled `SEC-OPLOG-03`, not `SEC-DEV-07`.
- The **surfacing** leg ships at `apps/server/test/security/sec-dev.test.ts` (anomaly counts + last-anomaly-at).

So the id may already be whole across two tests, with no single test completing it — a §2.1.6 question, not a coverage hole. **Do not assume; read both, and decide whether §221's "simulate extracted signing key" framing needs its own scenario or is satisfied by SEC-OPLOG-03's.** If satisfied, title SEC-DEV-07 on the completing test and drop the row. If not, ship the missing scenario.

## Resolution applied (D18 §2, 2026-07-20)

**Decision taken: (a) §218 is over-specified — per the owner's D18 §2 ruling.** The work is done as follows.

### SEC-DEV-04 — RETIRED honestly

1. **Doc (already committed, c7bc21b on `main`):** `security-guide §218` was rewritten to the wiped-not-leaked guarantee — the 401→`DEVICE_REVOKED` wire path (api/02-auth §8/§10) with §7.3's confirm-then-wipe as the terminal step; the "queued ops → `DEVICE_REVOKED`, kept + surfaced as `rejected`" over-specification is dropped, with the reason recorded inline. Verified §7.3 (`:449`, "destroyed with the rest — by design") and the 401 mapping (`:496`) back the new wording.
2. **Test titles it:** `packages/core/test/sync/offline-revocation.test.ts`'s `describe` now carries `SEC-DEV-04` verbatim (no partial-leg qualifier), backed by the three real assertions (behaviours 1/3/5 + a positive control). The stale "id deliberately absent" header comment was rewritten to record the D18 resolution.
3. **De-allowlisted:** `SEC-DEV-04` removed from `packages/test-support/src/sec-pending-allowlist.json`.
4. **Gate falsified (§2.11), not assumed:**
   - Broke behaviour-5's assertion (`toBe('local')` → `toBe('synced')`) → the `SEC-DEV-04`-titled owning test went **red** (`AssertionError: expected 'local' to be 'synced'`, `offline-revocation.test.ts:185`) → reverted → green. The title sits on a real, evaluated assertion.
   - Removed `SEC-DEV-04` from the `describe` title (already de-allowlisted) → the sec-meta gate went **red** (`SEC ids with neither a test title nor an allowlist entry: [ 'SEC-DEV-04' ]`) → reverted → green. The gate keys on the verbatim title, not a comment/mention/content.
   - Intermediate contradiction also observed live: title present + row still allowlisted → **red** (`titledButPending: SEC-DEV-04 → …70… (a test titles the id, but the row still says it is owed)`).

### SEC-DEV-07 — NOT retired; stays allowlisted → task 70 (reported, not forced)

D18 rules **only** on SEC-DEV-04/§218; it says nothing about SEC-DEV-07. Traced to producers (T-16), §221's requirement is genuinely built but **split across two tests with no single completing test**, so it cannot be retired "the same honest way":

- **Generation leg** — `apps/server/test/integration/oplog/sec-oplog.test.ts:241` (`SEC-OPLOG-03 CHAIN_BROKEN raises a tamper alarm …`): `breakPreviousHash(op2, …, world.secretKey, …)` re-signs with the device's REAL key + stale chain → `CHAIN_BROKEN` anomaly row. This is exactly §221's "correct signature, stale chain state", but titled `SEC-OPLOG-03`.
- **Surfacing leg** — `apps/server/test/security/sec-dev.test.ts:233` (untitled): `GET /v1/devices` surfaces `device_anomalies` counts + last-anomaly-at — but from **seeded** anomaly rows, not from a forge.

Neither test completes the id: the generation test never touches `GET /v1/devices`, and the surfacing test never forges. §221 promises "the documented §6.2 mitigation **actually fires**" end-to-end (forge → anomaly row → owner-visible count), and **no assertion links the two halves**. Retiring it honestly requires shipping that one end-to-end scenario in `apps/server/test` (a new test, outside this task's declared footprint and not covered by any ruling) — not titling either partial test (which would be the SEC-META-01 defect, and would trip `partialLegTitles`/`titledButPending`). Per the D18 scope and CLAUDE.md §2.11, it is left allowlisted rather than forced green. **Consequence:** task 70 still owns an unshipped SEC-DEV-07, so it cannot be marked `done` as-is — the orchestrator should either keep 70 open on SEC-DEV-07 or split it into its own task.

## Acceptance

- §218's contradiction is resolved by an explicit, recorded decision — **spec first, then code** (security-guide's own change-control rule), never by editing a test until it passes.
- SEC-DEV-04 and SEC-DEV-07 each end **either** fully shipped and titled by the test that completes them, **or** still allowlisted with this task's marker declaring them. No partial-leg title may carry either id — SEC-META-01's `partialLegTitles` rule (task 61) now fails the build if one does.
- The three behaviours already proven (`packages/core/test/sync/offline-revocation.test.ts`) are **not** re-implemented (§2.8) — retitle or extend them, do not fork them.
- **Falsify before believing** (§2.11): break the leg, watch that specific test go red, restore. Report as *"broke X, saw Y fail, reverted"*.

## Note

Task 54 was refuted by its own implementer; task 61's ownership premise was refuted the same way one task later. Both were filed from an audit of **titles**, and both times the titles were uncorrelated with what the code did — in opposite directions (54: shipped-but-untitled; 61: titled-but-unbuildable). **A mention is not a producer, and neither is a spec row** (T-16). The gate half of both tasks was real and both are now closed; the "just ship the leg" half was fiction both times.
