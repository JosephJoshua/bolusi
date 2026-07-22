# TASK 157 — add a device→store scope rule: a device may write only its OWN store's ops, not any store of its tenant

**Status:** in-review
**Priority:** **HIGH — permission-matrix change (CLAUDE.md §6), owner-approved (D22).** Closes the `05 §9.2` gap where a mechanic at Branch A can write a repair note into Branch B's book.
**Depends on:** 141 (the ruling), 07 (op-log pipeline scope step), 140 Leg B (the adjacent per-op scope check to model on)
**Blocks:** —
**SEC ids owned by THIS task:** SEC-TENANT-06

SEC-TENANT-06 is a device→store write-scope control (the next free SEC-TENANT id; the §12 roll-up ended at 05). It is added to `security-guide.md` §8.2 + §12 roll-up so `sec:inventory` counts it, and shipped with a verbatim-id adversarial test title (`apps/server/test/integration/sync/store-scope-binding.test.ts`) so SEC-META-01 reds if a passing test stops carrying it.
**Filed by:** the orchestrator, 2026-07-22, from the D22 owner ruling on task 141b.

## The ruling (D22)
The owner ruled that a device must NOT be able to write ops into another store of its tenant. `05 §9.2` as written permits it (the code correctly matches the spec); the SPEC and matrix are what change.

## The finding (reproduced by the QA adversarial sweep, real PG16)
A store-1 device's op scoped to store 2 is **accepted** and pokes store 2 (HTTP-E in the 114/141 sweep). There is no device↔store equality rule at the scope step.

## Deliverable
- Add a scope sub-rule at the pipeline's scope step (`apps/server/src/oplog/steps/scope.ts`, alongside the existing tenant/user binding and the task-140 `mediaRef` binding): an op whose `storeId` is not the pushing **device's** store is rejected **per-op** as `SCOPE_VIOLATION`. Read `05 §9`, `02-permissions.md`, and `10-db-schema.md §6` for how a device's store is resolved (`devices.store_id`), and whether a **system/multi-store device** concept exists (kind `system` has `store_id NULL` per the schema) — if so, the rule must carve it out correctly (a system device may legitimately be tenant-scoped). **If that carve-out is ambiguous, STOP and report** — a wrong carve-out either breaks system-device sync or reopens the hole.
- Update `05 §9.2` and `security-guide.md` to state the rule (same change). Re-examine any spec'd multi-branch/cover-other-branch flow against this rule BEFORE landing — the ruling explicitly warns it must not silently break a legitimate multi-store flow.
- Use the existing `SCOPE_VIOLATION` code (no new rejection code — §6). Do NOT weaken tenant isolation (RLS) — this is an ADDITIONAL, narrower scope, not a replacement.

## FALSIFY (§2.11 — REPORT it, real PG16, attributed T-14d)
- Reproduce HTTP-E first (a store-1 device's store-2 op is accepted) and lead with it.
- After the fix: a device pushing an op scoped to a store that is not its own is rejected per-op as `SCOPE_VIOLATION`; the **honest same-store sibling in the same batch still commits and is durably logged** (§4.1 — the property tasks 139/140B protect; do not regress it).
- **Positive controls:** (1) a device pushing its OWN store's op is accepted and folded; (2) if a system/multi-store device concept exists, a legitimately tenant-scoped op from it is accepted — otherwise the rule is "reject everything cross-store" and would break system devices.
- Break the new rule → the reproduction is accepted again → red. Restore → green. Predict each; stamp the DB lane owner.

## Note
Model the implementation on task 140 Leg B's `mediaRef`→envelope binding (same file, same per-op `SCOPE_VIOLATION`+`continue` shape, same §4.1 sibling-survives property). This is a security control being ADDED, so it ships with adversarial tests BEFORE review (security-guide discipline), not after.

## Outcome

**Where.** `apps/server/src/oplog/steps/scope.ts` — one per-op sub-rule at the §9.2 store check; existing `SCOPE_VIOLATION` code, no new rejection code. Tests: `apps/server/test/integration/sync/store-scope-binding.test.ts` (real PG16, production `createApp` + `serverOpRegistry`). Specs: `05-operation-log.md §9.2`, `security-guide.md §8.1/§8.2 (SEC-TENANT-06)/§12 roll-up (TENANT 01–06)`; denominator gate `packages/test-support/src/sec-inventory.test.ts` 57→58.

**The rule (derived, not blanket).** Reject when `op.storeId !== null && op.storeId !== device.storeId`. NOT `device.storeId === op.storeId`: a member device legitimately emits TENANT-scoped ops (`storeId = null`) — `platform.user_locale_changed` (01 §6 line 233) and a tenant-scoped-entity `conflict_acknowledged` — so `null` passes. Member `store_id` is always non-null (10-db §4 CHECK line 137). The tenant SYSTEM device (`store_id` null) signs only `platform.conflict_detected`, built via `appendSystemOp` → `insertOperationRow`, which bypasses `checkScope` entirely (01 §3.6 "no carve-outs to §9's scope checks") — so the rule is keyed on the device's own store, needs no kind-branch, and rejects no legitimate op. No ambiguity found → no STOP-and-report needed.

**Reproduction (real PG16, T-14d — db `bolusi_tmpl`, owner `l3lane-1123-mrw7plz4`).** Before the rule: a store-1 member device pushing a note scoped to store-2 (same tenant) is `accepted` (expected `rejected`/`SCOPE_VIOLATION`) — durably logged and store-2 poked (HTTP-E). REPRO + SIBLING legs red; provenance + both positive controls green.

**Falsification (§2.11).** Neutralised the rule (`if (false && …)`) → REPRO + SIBLING red with exact `status: accepted` vs `rejected` (predicted: cross-store op accepted again), positive controls stay green. Restored → green. Existing `platform-registration.test.ts:132` (tenant-scoped locale accepted+folded) still green — the encoding's `op.storeId !== null` clause is what preserves it.

## Outcome — round 2 (REJECTED by review; the guarantee was an overclaim, now made true)

**The reject.** The rule above guards the op's DECLARED `storeId`. The mutation appliers resolve their target row from `entityId` and never read `op.storeId`, and `notes` RLS is TENANT-only — so `UPDATE notes … WHERE id = op.entityId` crossed stores. "A device may write only its OWN store's ops" was therefore false for edit/archive. Not narrowed to "create only" (owner ruled the full guarantee, D22 §3) — closed.

**Reproduced first (real PG16, T-14d — PostgreSQL 16.14 (Debian 16.14-1.pgdg13+1), db `bolusi_tmpl`, per-run lane owners e.g. `l3lane-541554-mrwaehz3` / `l3lane-531350-mrwacaa1`), three dodges against a store-2 note owned by a store-2 device:**
- **(A) `storeId = null` edit** → `accepted` (expected `SCOPE_VIOLATION`). Dodges the declared-store rule, which only fires on a NON-null store. Strictly worse: a null store widens pull scope (`storeId = device.storeId OR storeId IS NULL`), so every store-2 device re-folds it locally.
- **(B) `storeId = attacker's OWN store` edit** → `accepted` and the victim row observed changing **`body: "HONEST BODY"` → `"PWNED BY STORE-1 DEVICE"`** with `store_id` still store-2. The decisive, directly-observed cross-store write.
- **(C) `storeId = null` archive** → `accepted` (would set the terminal `archived`).

**A false green found and removed en route (§2.11).** Dodge (B) first PASSED. Both `ChainBuilder`s start at the same timestamp base, so the attack op tied the victim's create on `timestamp` and the canonical key fell through to `deviceId`: the edit sorted BEFORE the create, folded onto a not-yet-existing row (no-op), and the create then inserted the honest body. The note survived by accident of ordering while the hole was wide open. Every attack op is now stamped `AFTER_VICTIM`, which is what makes the reproduction real.

**The two legs.**
- **Leg 1 — `scope.ts`:** a STORE-scoped op TYPE carrying `storeId = null` → `SCOPE_VIOLATION`. Scope is read from the declaring module (`OperationDeclaration.scope`, default `'store'`) through a new `OpRegistry.scopeOf` seam (`deriveOpRegistry`), never a hardcoded notes list; unknown types return `undefined` and fall through to `UNKNOWN_TYPE`. `platform.user_locale_changed` is the one `scope: 'tenant'` type in v0, so PC2 still passes. `SCOPE_VIOLATION` not `SCHEMA_INVALID`: `storeId` is an ENVELOPE field and §9 owns envelope consistency; §8 is the payload verdict.
- **Leg 2 — `notes/applier.ts`:** `note_body_edited`/`note_archived` UPDATE `… WHERE id = op.entityId AND store_id = noteStoreId(op)`, so a store mismatch is a no-op fold. Generalised into `04-module-contract §4.1.3` so every future module owes it.

**Falsification of each leg (predicted → observed, real PG16).** Broke leg 1 → predicted A+C accepted again, B still safe: observed exactly 2 red (A, C), B and all positive controls green. Broke leg 2 → predicted only B regresses: observed exactly 1 red (B) with `body → "PWNED BY STORE-1 DEVICE"`, A/C green. Both restored → 9/9 green.

**Positive controls (all green throughout, so neither leg closed the hole by breaking the feature).** Own-store create accepted+folded; a legitimate same-store edit AND archive still fold; tenant-scoped `platform.user_locale_changed` (null store) still accepted.

**Corrected en route.** `pipeline.test.ts`'s "accepts a tenant-scoped op with storeId null" was pushing a **notes** op (store-scoped) with a forced null store — it asserted the very dodge as correct behaviour. Repointed at the genuinely tenant-scoped type, plus a new test asserting a store-scoped null-store op is rejected and never logged. Three test `OpRegistry` stubs gained `scopeOf` via one shared `testScopeOf` helper (§2.8), not four copies. The reviewer's non-blocking note is fixed: the "store-less device is never constrained" justification was a non-sequitur (`conflict_detected` carries a NON-null store) — the comment now says the carve-out rests entirely on `appendSystemOp` bypassing `checkScope`, and flags that routing system ops through push breaks detection there deliberately.

**Verify (each with its EXIT).** `tsc -b` 0 · `typecheck` 0 · `lint` 0 · `test:server` **557/80 files** 0 · `harness` **136/18** 0 (two long chaos tests hit the 120 s wall under sustained machine load — load avg 8.8–10, 30 containers; both pass in isolation, zero `SCOPE_VIOLATION`/rejections in their logs, and convergence would have FAILED rather than timed out had a legitimate op been rejected; green at `--testTimeout=400000`) · `test:security` **11/3** 0 · `test-support` **219/20** 0 · `@bolusi/modules` **58/10** 0 · `@bolusi/core` **1110/71** 0 · `knip` +0 new 0.
