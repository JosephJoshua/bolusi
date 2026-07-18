# TASK 100 — delete the hand-rolled `isPermissionDeniedPayload`, repoint to the Zod validator (a real STRENGTHENING, not a behavior-identical dedup)

**Status:** done
**Priority:** **LOW-MEDIUM** — the symbol is test-only, so no production impact today; but it closes a real under-validation AND a T-15 false comment on the denial-audit (FR-1045) surface, and it removes a §2.8 duplicate. Deferred from task 45 because it is NOT behavior-preserving (a behavior change on a security surface deserves its own commit + review — proven, not assumed).
**Depends on:** 43, 44, 45
**Blocks:** —
**SEC ids owned by THIS task:** none (hardens the `permission_denied` payload contract; no new id)

## The finding (task 45, premise-refuted empirically)

The orchestrator asked task 45 to dedup `packages/core/src/authz/denials.ts`'s hand-rolled `isPermissionDeniedPayload` against task 43's Zod `permissionDeniedPayload`, on the premise "both already consume the same `DENIAL_REASONS` — behavior-identical." **impl-45 proved that premise FALSE** (throwaway test, run + deleted):
- They agree on the entire existing test corpus (valid, every missing-key variant, bad `surface`, negative/fractional `suppressedRepeats`, wrong-type `scopeStoreId`, extra key, `null`).
- They **disagree on exactly two inputs**: `permissionId: ''` and `reason: 'made_up_reason'` — the hand-rolled predicate returns `true`; the Zod schema returns `false`.
- Cause: the hand-rolled predicate checks `typeof permissionId === 'string'` / `typeof reason === 'string'` (it does NOT consume `DENIAL_REASONS`), whereas Zod has `permissionId: z.string().min(1)` and `reason: z.enum(DENIAL_REASONS)`. **Zod is strictly tighter** and is ALREADY the authoritative validator on the real op path (`auth/module.ts:178`).

So this is a **strengthening toward the shape the registry already enforces**, on inputs unreachable via typed callers (the hand-rolled predicate is used only in tests + the barrel; the untrusted wire path already uses Zod). It correctly stopped rather than ship a false equivalence claim.

## Two constraints for whoever lands it (from task 45)

1. **`authz/denials.ts` CANNOT import the Zod schema from `auth/`** — that inverts the existing `auth → authz` dependency into a cycle. The dedup must **DELETE** the hand-rolled predicate and repoint its two test consumers (`test/authz/denials.test.ts`, `test/runtime/permission.test.ts`) to `permissionDeniedPayload.safeParse(x).success`.
2. All existing test assertions stay green under the swap (proven by task 45). The only behavior change is the two divergent inputs now correctly rejected.

## Also fix (T-15 false comment, same surface)

`packages/core/src/auth/projections/permission-denials.ts:36` states "Both consume `DENIAL_REASONS`, so there is no second reason list." **False** — the hand-rolled predicate does not consume `DENIAL_REASONS` (it accepts any string reason). This comment is part of why the dedup looked trivially behavior-identical. After deleting the predicate the comment becomes true (only the Zod path remains); update it to say so, or remove it.

## Acceptance

- Delete `isPermissionDeniedPayload`; repoint the two test consumers to `permissionDeniedPayload.safeParse(...).success`. No `auth → authz` cycle introduced (verify the import direction).
- **Falsify the strengthening (§2.11):** a test pinning that `permissionId: ''` and `reason: 'made_up_reason'` are now REJECTED (were accepted by the deleted predicate) — and that every previously-accepted valid payload still passes. This is the behavior change; make it visible and asserted.
- Fix the `permission-denials.ts:36` comment (T-15).
- `pnpm typecheck`/`pnpm lint`/`pnpm test` green — read the output (§2.1). Client-side only (no server/RLS).

## Note
Filed from task 45. The lesson worth keeping: an orchestrator instruction ("these are behavior-identical, just dedup") is a HYPOTHESIS — task 45 tested it, found two divergent inputs, and refused to ship the false claim. That is the T-16 "a mention is not a producer / test the premise" discipline applied to a *coordinator's own premise*. The dedup is right; it just isn't free.
