# TASK 157 — add a device→store scope rule: a device may write only its OWN store's ops, not any store of its tenant

**Status:** todo
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

**Falsification (§2.11).** Neutralised the rule (`if (false && …)`) → REPRO + SIBLING red with exact `status: accepted` vs `rejected` (predicted: cross-store op accepted again), positive controls stay green. Restored → 5/5 green. Full suites: `test:server` 552, `harness` 136, `test:security` 11 (SEC-TENANT-04 unaffected — its push probe is cross-TENANT, rejected by the tenant check before this rule), `test-support` 219 (SEC-META-01 sees the SEC-TENANT-06 title), typecheck/lint/knip all EXIT=0. Existing `pipeline.test.ts:414` (member `storeId:null` accepted) and `platform-registration.test.ts:132` (tenant-scoped locale accepted+folded) still green — the encoding's `op.storeId !== null` clause is what preserves them.
