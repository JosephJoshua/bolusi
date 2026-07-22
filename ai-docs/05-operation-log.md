# 05 — Operation Log

> **Owns:** the operation envelope, canonical serialization, hashing, chaining, signing, ordering, idempotency, append-only invariants. Every other doc references this one; none may redefine it.
> **Change control:** change this doc first, then code. Envelope changes after first production op require a `schemaVersion` bump strategy, never a field redefinition.

## 1. The invariant

Operations are **append-only**. No update path, no delete path for the signed core — the functions do not exist in the codebase (lint-enforced: no `UPDATE`/`DELETE` touching signed-core columns of `operations` tables, anywhere). The **sync engine alone** may update the client-local bookkeeping columns (§2.3), and nothing may update anything else. A correction is a new operation. If a projection and the log disagree, the log is right.

## 2. Envelope

Two layers: the **signed core** (immutable, hashed, signed) and **bookkeeping** (mutable, local/server-side, never signed).

### 2.1 Signed core (all fields REQUIRED unless noted)

| Field | Type | Semantics |
| ----- | ---- | --------- |
| `id` | UUIDv7 string | Client-generated at append. Global dedupe key. |
| `tenantId` | UUID string | Owning tenant. Never null. |
| `storeId` | UUID string \| null | Owning store. Null = tenant-scoped op (e.g. `platform.user_locale_changed`). |
| `userId` | UUID string | Acting human. Never null, never a shared account. |
| `deviceId` | UUID string | Originating enrolled device. |
| `seq` | integer ≥ 1 | Per-**device** monotonic counter. Gap detection. |
| `type` | string | `<module>.<event>`, past tense: `notes.note_created`, `auth.user_switched`. Must exist in the operation registry (04-module-contract). |
| `entityType` | string | e.g. `note` |
| `entityId` | UUIDv7 string | The entity this op belongs to. Client-generated for creations. |
| `schemaVersion` | integer ≥ 1 | Version of this `type`'s payload schema. |
| `payload` | object | Zod-validated against the registry schema for (`type`, `schemaVersion`). |
| `timestamp` | integer | ms epoch, **device clock at the moment the user acted**. Preserved through late sync. |
| `location` | `{lat, lng, accuracyMeters}` \| null | Best available fix, or null. Never blocks (PRD-009 FR-802). |
| `source` | `"ui" \| "agent" \| "api" \| "system"` | Default `"ui"`. |
| `agentInitiated` | boolean | Default `false`. Present from day one (ARCH-001 §9.3). |
| `agentConversationId` | string \| null | Default `null`. |
| `previousHash` | hex string (64) | `hash` of this device's previous op (`seq − 1`). Genesis op (`seq = 1`): 64 zeros. |

### 2.2 Derived (computed at append, immutable)

| Field | Type | Semantics |
| ----- | ---- | --------- |
| `hash` | hex string (64) | SHA-256 over the canonical serialization (§3) of the signed core. |
| `signature` | base64 string | Ed25519 signature over the raw 32-byte hash, by the device's private key. |

### 2.3 Bookkeeping — client-local, NEVER signed

| Field | Values |
| ----- | ------ |
| `syncStatus` | `local` → `synced` \| `rejected` (state machine in 03-state-machines) |
| `syncedAt` | ms epoch \| null |
| `rejectionCode`, `rejectionReason` | set when `rejected`; must be surfaced to the user, never silent |

### 2.4 Bookkeeping — server-side, added on acceptance

| Field | Semantics |
| ----- | --------- |
| `serverSeq` | Per-**tenant** monotonic bigint, assigned on acceptance. Pull-cursor basis (api/01-sync). |
| `receivedAt` | Server ms epoch. |
| `clockSkewFlagged` | boolean — see §6. |

## 3. Canonical serialization

`hash = SHA-256( JCS(signedCore) )` where JCS = **RFC 8785 JSON Canonicalization Scheme** over exactly the §2.1 fields (no bookkeeping, no `hash`, no `signature`).

Rules:
- Absent-vs-null: nullable fields are ALWAYS present, explicitly `null`. No optional keys in the signed core.
- Numbers: `seq`, `timestamp`, `schemaVersion` are integers; `payload` numbers must be integers or decimal strings — **money is always integer IDR** (no floats anywhere in payloads; lint + Zod-enforced).
- The same JCS implementation must be used on client and server (shared package `@bolusi/core`).
- **Verbatim storage:** both stores persist the exact JCS text of the signed core (`signed_core_jcs`, 10-db-schema §2.1) and pull responses are served from it. Reconstructing the core from typed columns (e.g. Postgres `jsonb`, which re-serializes numerics) is forbidden for any signature-verification path — re-serialization can change bytes and fail genuine signatures.

## 4. Chain and ordering

- **Chain is per-device**, spans users (PIN switch does not break it). Verifies: no deletion, no reorder, no injection into a device's history (PRD-009 §2.6).
- **Canonical total order** for projections and any cross-device fold: `(timestamp ASC, deviceId ASC, seq ASC)`. Deterministic for any op set regardless of arrival order (FR-1118 hinges on this).
- `serverSeq` is **arrival** order, used only as sync cursor. Never used for business ordering.

## 5. Idempotency

Dedupe key is `id`. Server: replaying an already-accepted op returns `duplicate`, changes nothing. Client pull: applying an op whose `id` exists locally is a no-op. Backup-restored devices therefore cannot double-apply history.

## 6. Clocks

- `timestamp` is the device's honest belief. It is business truth ("when the employee acted"), preserved through late sync.
- Server flags (`clockSkewFlagged = true`, never rejects) when `|timestamp − receivedAt|` is grossly inconsistent with the device's offline window: skew threshold = 48h + (receivedAt − device's lastSyncAt). Flagged ops feed reporting; assume drift, not malice (PRD-009 §6).

## 7. Reversals

Every op `type` registers a human-readable `reversal` description at definition time (04-module-contract §3). v0 requires the documentation; executable `buildReversal` is V2 (agent undo). Retrofitting reversals is forbidden by construction — the registry field is mandatory.

## 8. Rejection codes (server → client)

| Code | Meaning | Client behavior |
| ---- | ------- | --------------- |
| `BAD_SIGNATURE` | Signature does not verify against device pubkey | Mark rejected; surface; likely corruption or tamper |
| `CHAIN_BROKEN` | `previousHash` mismatch for claimed `seq` | Mark rejected; surface loudly; halt push (sets `pushHalted`), require investigation |
| `CHAIN_GAP` | `seq` skips ahead of last accepted | Client resends from gap (not an error state) |
| `CHAIN_HALTED` | Not individually validated — an earlier op in this batch was `CHAIN_BROKEN`, so nothing after it can be chain-verified | Mark rejected; surface; push already halted by the triggering `CHAIN_BROKEN` (does not set `pushHalted` again) |
| `DEVICE_REVOKED` | Op received after device revocation | Mark rejected; surface; device must re-enroll |
| `SCHEMA_INVALID` | Payload fails registry Zod for (`type`, `schemaVersion`) | Mark rejected; surface; bug — report |
| `SCOPE_VIOLATION` | tenant/store/user/type-rule inconsistent (§9) | Mark rejected; surface; bug or tamper |
| `UNKNOWN_TYPE` | `type` not in server registry | Mark rejected; surface; version-skew — prompt app update |

A rejected op stays in the local log flagged `rejected` — it is never deleted, and the user is always told (PRD-012 §6 "silent rejection is unacceptable").

## 9. Scope validation (server, on push)

Accept only if all of the following hold. Fail closed.

1. **Token binding:** op.`deviceId` == the bearer-token-authenticated device's id (and the push body's `deviceId` likewise). A valid token cannot push ops claiming another device.
2. op.`tenantId` == device.`tenantId`; op.`storeId` is null (tenant-scoped) or belongs to the tenant. **A device may write only its OWN store's ops (D22, SEC-TENANT-06).** That guarantee covers CREATING *and* MUTATING, and it takes three rules together — the first two here, the third in 04-module-contract §4.1:

   **(a) A store-scoped op TYPE must carry a store.** An op whose declared type is store-scoped (01-domain-model §6; `OperationDeclaration.scope`, default `'store'`) but whose envelope `storeId` is null is rejected `SCOPE_VIOLATION`. The scope is read from the DECLARING MODULE, never a hardcoded type list, so a new store-scoped type is covered the moment it is declared. An unknown type is left to the schema step's `UNKNOWN_TYPE` (§8) rather than pre-empted here.

   **(b) A non-null op.`storeId` must be the pushing device's own store.** A store of the tenant *other than* the device's `store_id` is rejected `SCOPE_VIOLATION` — closing the gap where a device at store A writes an op into store B (a mechanic recording a repair note in another branch's book).

   Rule (a) is what makes (b) unbypassable, and it is not hypothetical: (b) can only fire on a NON-null store, so `storeId = null` slipped past it while the mutation appliers — which resolve their target row from `entityId`, not from op.`storeId` — wrote into another store anyway. A null store is also the *worse* variant, because it widens PULL scope (`storeId = device.storeId OR storeId IS NULL`, api/01-sync §4.1): every device in the victim store re-folds the forgery locally.

   Tenant-scoped ops (op.`storeId` = null on a type declared `scope: 'tenant'`) are **not** store-bound and pass both rules: `platform.user_locale_changed` is the one such type in v0 — the preference follows the user to every device (01-domain-model §6). Member devices always carry a `store_id` (10-db-schema §4 `CHECK (kind = 'system' OR store_id IS NOT NULL)`) and the runtime stamps it into every store-scoped op (02-permissions §5.2), so for those op.`storeId` == device.`store_id`.

   The tenant **system** device (`store_id` null) signs only server-built `platform.conflict_detected`, chained server-side (10-db-schema §3) and **never pushed** (01-domain-model §3.6 — "no carve-outs to §9's scope checks"). Note it carries a NON-null `storeId` (the conflicted entity's store), so rule (b) *would* reject it if it ever reached this step: the carve-out rests entirely on it never doing so, not on the system device being store-less. Routing system ops through push would break conflict detection here — deliberately, as a tripwire. Both rules are ADDITIONAL, narrower scopes on top of RLS (10-db-schema §6), never a replacement.
3. op.`userId` is a **member** of the tenant's user directory. Membership, not status: ops from users deactivated while the device was offline are accepted — the audit trail wants the record; deactivation gates *authentication and command execution* (03-state-machines §6), never op acceptance.
4. Device is `active` at receipt time (else `DEVICE_REVOKED`).
5. **Per-type push rules** (violation → `SCOPE_VIOLATION`). The v0 extension list — additions require changing this doc first:
   - `auth.device_enrolled` must be the device's genesis op (`seq` = 1, `entityId` = the device's own id).
   - `auth.pin_changed` / `auth.pin_reset` / `auth.pin_lockout_cleared` are permission-validated server-side against the directory (the one v0 exception to client-side-only authorization — see 02-permissions §4; rationale: PIN reset is impersonation power). Additionally, an `auth.pin_reset` targeting a user who holds the main_owner role is accepted only if the acting user also holds main_owner (api/02-auth §6.6 — blocks store-owner → main-owner impersonation).
   - `platform.conflict_detected` / `platform.conflict_acknowledged`: `conflict_detected` is accepted only from a tenant's system device; `conflict_acknowledged` from member devices.

## 10. Local retention (v0 rule)

Devices retain their full operation history — no pruning, no archival window in v0 (sized by testing-guide's SEED-200K gate). Server-side archival and device retention windows are a roadmap item (OQ-1102).
