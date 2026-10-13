# TASK 213 — PIN-verifier reset crosses the owner's store boundary

**Priority:** HIGH — a PIN reset is identity impersonation power (`api/02-auth.md` §6.6).
**Depends on:** —
**Blocks:** claiming v0 authorization is sound.
**Docs to read:** `02-permissions.md` §5.4 rule 3; `api/02-auth.md` §§5.4, 6.3, 6.6; `security-guide.md` auth checklist.
**Skills:** `implement-task`, `review-wave`, `qa-sweep`.
**Files / modules:** `apps/server/src/routes/users.ts`, authorization helpers and server auth tests; review `apps/server/src/oplog/steps/scope.ts` for the corresponding signed-op boundary without silently widening the v0 push-validation contract.
**Filed by:** 2026-10-13 v0 review; independently reproduced against an isolated PostgreSQL 16 endpoint fixture.

## Reproducing failure

Within one tenant, make the actor a store-A-only `store_owner` on a store-A device; make the target a non-`main_owner`, store-B-only user. POST a valid newer verifier for the target. The endpoint returned HTTP `200`, `{ "applied": true }`, and wrote the target's verifier (`ENDPOINT_PROBE_EXIT=0`). The store-A permission check at `apps/server/src/routes/users.ts:381` never checks the target's store memberships before the write at line 417. `02-permissions.md` §5.4 rule 3 requires those memberships to be within the actor's granted stores.

`apps/server/src/oplog/steps/scope.ts:30,194` separately asks whether the actor has this permission in *any* store. Confirm which store-boundary restrictions apply to the v0 signed-op validator before changing it: `api/02-auth.md` §6.3 explicitly defers the general pushed-op permission audit to v1. Do not present the endpoint proof as a proof of an independent signed-op privilege escalation.

## Acceptance / falsification

- An actor permitted only in store A cannot reset a store-B-only user: `403 PERMISSION_DENIED`, `restriction_violated`, with the required denial audit; the verifier remains unchanged. The same negative control must cover a target in both A and B if the subset rule applies.
- A valid owner reset of a user within the owner's granted stores still succeeds; an own PIN change still succeeds; the existing `main_owner` guard stays enforced.
- Exercise the actual route against production-shaped PostgreSQL, not only a mocked permission helper. Remove the target-membership check temporarily and watch the cross-store negative test fail; restore and pass.
