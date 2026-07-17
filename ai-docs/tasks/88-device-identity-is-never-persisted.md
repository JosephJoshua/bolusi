# TASK 88 — `deviceId`/`storeId` are never written to `meta_kv`; no device can be known-enrolled at boot

**Status:** in-progress
**Priority:** **HIGH** — blocks the sync loop, the zone gate's `device` input, and therefore v0's exit. `10-db §9` names these keys normatively; nothing produces two of the three.
**Depends on:** 14
**Blocks:** 25, 27a, 89

## The finding (task 50, 2026-07-16 — traced, not assumed)

`10-db-schema.md` §9 declares `meta_kv`'s contents outright:

```sql
CREATE TABLE meta_kv (             -- device identity + misc scalars
  key   TEXT PRIMARY KEY,          -- 'deviceId','tenantId','storeId','appSchemaVersion',...
```

**Three keys named. One producer.**

| key | producer | status |
| --- | -------- | ------ |
| `tenantId` | `packages/core/src/auth/bundle-apply.ts:35` — `writeMeta(db, TENANT_ID_META_KEY, bundle.tenant.id)` | **live** |
| `deviceId` | — | **none** |
| `storeId` | — | **none** |

The verification (T-16 — a mention is not a producer; trace to one): `grep -rn "writeMeta" packages/core/src apps` returns exactly four call sites — `bundle-apply.ts:35` (tenantId), `enrollment.ts:146` (the enrollment DRAFT), and two inside `projection/rebuild.ts` (its own cursor/version keys, a private `writeMeta`). **No call writes `deviceId` or `storeId`.**

**And the one place that holds a `deviceId` deletes it.** `enrollment.ts` persists a draft containing the `deviceId` *before* the POST (§4.3's crash-retry guarantee), then on success:

```ts
await deleteMeta(deps.db, ENROLLMENT_DRAFT_KEY); // enrollment complete — the draft is spent
return { deviceId: draft.deviceId, response, genesis, loggedIn: false };
```

The id is **returned to the caller and erased from the database in the same function**. A successful enrollment is the moment the device's identity stops being recoverable from disk.

## Why this is HIGH, not tidy

Three consumers, all blocked, none of which fails loudly:

1. **The zone gate's `device` input.** `Root.tsx` passes `device="unenrolled"` — and task 50's own comment is careful that this is the *true* state rather than a stub, precisely because there is no stored answer to read. There is no query that can return `active`.
2. **`SyncLoop`'s required `deviceId`** (`SyncLoopOptions.deviceId`, `packages/core/src/sync/loop.ts:87`). The loop cannot be constructed. Task 50 built the transport and the trigger adapters; they have no device to speak for.
3. **`deviceHasGenesis(db, deviceId)`** — enrollment's own idempotency backstop takes the id as a *parameter*. On a resumed run the draft supplies it; after the draft is deleted, nothing can.

**The failure mode is the dangerous one.** Nothing throws. `tsc` is green — `deviceId` is a local variable that is genuinely in scope everywhere it is used. The app boots, the wizard renders, and the device is simply never enrolled. Task 17 already proved `tsc` stays `EXIT=0` through a missing registration; this is the same shape one layer down.

## The fix, and the one judgement in it

Write `deviceId` and `storeId` to `meta_kv` at the point enrollment succeeds — the enroll response carries both (`response.store.id`; `draft.deviceId`) — and **before** the draft is deleted, so a crash between the two cannot lose the identity.

**The judgement:** `storeId` is also in the bundle, so `applyBundle` could write it — and that is the wrong home. `applyBundle` runs on every conditional-`GET` bundle refresh (api/02-auth §5), so putting the store binding there would let a server-side bundle change silently re-bind the device's store. §7.4 says a store binding is irreversible and costs an operator round-trip to undo; it must be written once, by enrollment, from the enroll response. Write it beside `deviceId` or not at all.

## Docs to read

- `10-db-schema.md` §9 (`meta_kv`'s declared contents — the contract this violates).
- `api/02-auth.md` §4.1 (the enrollment step order), §4.3 (the draft + Idempotency-Key crash-retry rule — **do not break it**), §7.4 (store binding is irreversible).
- `packages/core/src/auth/enrollment.ts` — the draft lifecycle and the `deleteMeta` at the end.
- `packages/core/src/auth/repo.ts` — `readMeta`/`writeMeta`/`readTenantId`; note `readTenantId` is the shape a `readDeviceId` should mirror (§2.8 — do not invent a fourth accessor pattern).
- `packages/core/src/auth/bundle-apply.ts:35` — the one live producer, and why `storeId` must NOT join it.
- `testing-guide.md` T-11, T-14, T-16.

## Acceptance

- After a successful enrollment, `readMeta(db, 'deviceId')` and `readMeta(db, 'storeId')` return the enrolled values, and they **survive a restart** (a test that only reads back in-process proves nothing about persistence — T-14b).
- The keys are written **before** `deleteMeta(ENROLLMENT_DRAFT_KEY)`. Prove the ordering: a crash injected between the two leaves a device whose identity is recoverable (the draft is still there), never one whose identity is gone.
- **A bundle refresh does NOT rewrite `storeId`** — the adversarial test for the §7.4 judgement above. Drive `applyBundle` with a bundle naming a different store and assert the stored `storeId` is unchanged.
- **Falsify** (§2.11): delete each `writeMeta` line, watch a specific test go red, restore. Report as "broke X, saw Y fail, reverted".
- **Denominator** (T-14): assert the full `meta_kv` key set after enrollment, not just that the two keys exist — a test asserting presence passes on a row that also wrote six keys nobody declared.
