# TASK 179 — `applyBundle` is atomic on the REFRESH path but not on ENROLLMENT: a mid-apply failure leaves partial directory rows

**Priority:** LOW — self-healing and fails closed overall, but an inconsistency worth closing. `applyBundle` writes several `meta_kv` keys and directory tables in sequence; the refresh caller wraps the whole thing in a transaction (`bootstrap/bundle.ts` → `config.db.transaction(...)`), but the enrollment caller does NOT (`packages/core/src/auth/enrollment.ts:105` calls `applyBundle(deps.db, response.bundle)` bare). So a failure *mid-apply* on the enrollment path — most plausibly `assertVerifierInBounds` throwing on a shape-valid-but-out-of-bounds PIN verifier (SEC-AUTH-01), which runs LAST in `applyBundle` after tenant/store/user/role rows are already written — leaves a partial directory.
**Depends on:** —
**Blocks:** —
**SEC ids owned by THIS task:** none.
**Filed by:** impl-161, 2026-07-25, while adding the runtime bundle gate (task 161).

## Why it is low, not zero
- Task 161's parse runs FIRST, before the first write, so every SHAPE/SIZE failure (over-long name, missing field, wrong enum) fails closed with nothing written. This task is only about failures that occur AFTER the parse passes — today that is the `assertVerifierInBounds` bounds check (and any raw DB error) mid-apply.
- Enrollment that throws mid-apply never appends the genesis op and never persists `deviceId` to `meta_kv`, so the device stays UNENROLLED; the orphaned partial directory is harmless and is wholesale-overwritten by the next `applyBundle` (it is idempotent — `replaceUsersDirectory`/`replaceRolesDirectory` replace, not append). So it is self-healing, not a corruption.

## Deliverable
Make `applyBundle` atomic regardless of caller: either wrap its body in a transaction internally, or wrap the `runEnrollment` call site the same way `bootstrap/bundle.ts` wraps the refresh. Prefer making `applyBundle` own its atomicity (one definition, §2.8) so no future caller can forget the wrapper. Falsify by forcing a mid-apply throw (an out-of-bounds verifier) on the enrollment path and asserting NO directory row / meta key survives — today `tenantId`, `auth.storeName`, `auth.tenantName`, `auth.idleLockSeconds`, and the user/role rows survive the throw.
