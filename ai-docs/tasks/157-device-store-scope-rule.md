# TASK 157 — add a device→store scope rule: a device may write only its OWN store's ops, not any store of its tenant

**Status:** in-progress
**Priority:** **HIGH — permission-matrix change (CLAUDE.md §6), owner-approved (D22).** Closes the `05 §9.2` gap where a mechanic at Branch A can write a repair note into Branch B's book.
**Depends on:** 141 (the ruling), 07 (op-log pipeline scope step), 140 Leg B (the adjacent per-op scope check to model on)
**Blocks:** —
**SEC ids owned by THIS task:** propose **SEC-TENANT-06** (or the next free SEC-TENANT id) — a device→store write-scope control. Add it to `security-guide.md` §12 roll-up and wire the sweep so it reds if a passing test stops carrying it.
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
