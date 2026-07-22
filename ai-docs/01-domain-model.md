# 01 — Domain Model (v0)

> **Owns:** every v0 entity, its fields, semantics, relationships, nullability, and invariants — Tenant, Store, User, Role, grants, Device, the system actor, Employee forward-ref, SyncState, MediaItem, Conflict (including v0 minor-vs-significant semantics and conflict classification), the projection pattern, the platform op-type registry (§6), and the `notes` reference-module entities. The Permission registry-entry shape is owned by `02-permissions.md §3.1` and mirrored here. The auth op registry is owned by `api/02-auth.md §6.2`. The operation envelope is owned by `05-operation-log.md` and is only referenced here. Physical DDL is owned by `10-db-schema.md`. State-machine transitions are owned by `03-state-machines.md`; this doc uses those exact state names.
> **Change control:** change this doc first, then the code.

## 1. Two data planes

Everything user-facing follows the core model (PRD-012 §2): append-only operations, projected state. Identity and infrastructure cannot be operation-sourced: the server must know tenants, devices, users, roles, and permissions **before** it can validate operations at all (05-operation-log §9), and credential material must never ride an immutable, replicated log. v0 therefore has exactly two data planes:

| Plane | Entities | Source of truth | How clients learn about it |
| ----- | -------- | --------------- | -------------------------- |
| **Directory** (server-administered rows) | Tenant, Store, Device, User, Role, grants, PIN verifiers, Permission registry | Server tables, mutated only by provisioning and the online control-plane endpoints (api/02-auth) | Enrollment bundle + conditional `GET /v1/devices/me/bundle` (api/02-auth §5.2) and the pull `devices` sidecar (api/01-sync §4), mirrored into client directory tables (§4) — **never from ops** |
| **Operation-sourced** (projections of the log) | Conflict, user preferences, auth audit projections, all module entities (v0: notes) | The operation log (05-operation-log §1) | Ordinary sync pull; projections fold identically on client and server |

Rationale, stated once: a validator whose validity data is derived from the log it validates is circular — device public keys, users, roles, and permissions must exist server-side before op #1 is accepted. And the log is append-only and replicated forever: a PIN hash inside an op payload would be an unrotatable secret (§4.1) — forbidden. Identity is therefore server-administered. Offline needs are met without op-sourcing it: offline PIN auth (PRD-011 FR-1010) and offline permission checks (FR-1032) read the client directory mirrors, populated from the enrollment bundle and refreshed by one conditional bundle check per sync loop (`304` steady-state — api/02-auth §5.2). Everything that *can* be operation-sourced *is* — business entities, conflicts, preferences, audit projections.

Human-initiated directory mutations (user/role management, device revocation) are recorded in the server's `identity_audit` log — who, what, when, before/after (10-db-schema); the directory row remains the enforcement truth. The operation log records business activity, not identity administration. The auth ops that do exist (sessions, PIN lifecycle, enrollment genesis, denials — api/02-auth §6.2) are audit and trigger records that carry no credential material.

## 2. Entity catalog

| Entity | Plane | Scope | Id | v0 |
| ------ | ----- | ----- | -- | -- |
| Tenant | directory | — | UUIDv7 | yes |
| Store | directory | tenant | UUIDv7 | yes |
| Device | directory | tenant + store | UUIDv7 | yes |
| Permission (registry entry) | directory (code-defined) | global | string `<module>.<action>` | yes |
| User | directory | tenant | UUIDv7 | yes |
| Role | directory | tenant | UUIDv7 | yes |
| UserRoleGrant / UserStoreAssignment | directory | tenant | composite | yes |
| PIN verifier | directory | tenant + user | keyed by userId | yes — record shape owned by api/02-auth §5.3 |
| Employee | — | tenant | — | **forward ref only** (v1, PRD-007) |
| Operation | the log itself | tenant | UUIDv7 | yes — envelope owned by 05-operation-log §2 |
| SyncState | client-local | device | singleton | yes |
| MediaItem | hybrid (client queue + server registration) | tenant + store | UUIDv7 | yes |
| Conflict | op-sourced | tenant or store | UUIDv7 | yes |
| UserPrefs | op-sourced (platform module) | tenant + user | keyed by userId | yes (§6, §7) |
| Note | op-sourced (reference module) | store | UUIDv7 | yes |

All ids are UUIDv7, lowercase canonical text form. All timestamps are ms-epoch integers. Money is integer IDR (no money fields exist in v0 core entities; the rule binds module payloads per 05-operation-log §3).

## 3. Directory entities

### 3.1 Tenant

| Field | Type | Semantics |
| ----- | ---- | --------- |
| `id` | UUIDv7 | |
| `name` | string | Display name. |
| `activeModules` | string[] | Module ids enabled for the tenant. v0: `["notes"]`. Commands/queries of a disabled module deny (fail closed). |
| `configuration` | JSON object | Tenant flags/defaults (FR-1042). v0 keys: none required; shape is open, additive. |
| `createdAt` | ms epoch | |

Created only by **server-side provisioning** (the `bolusi_provision` role — v0: an operator CLI, run by us; no self-serve signup). Provisioning atomically creates: the tenant, ≥1 store, the **system actor** and **system device** (§3.6), the first owner user (main owner), and the three default roles (§4.2) — all as directory rows with `identity_audit` entries. **No operations are appended at provisioning**; each device's log begins with its own `auth.device_enrolled` genesis op at seq 1 (api/02-auth §6.2). There is no cross-tenant anything (FR-1040, FR-1041).

Tenant suspension does not exist in v0: there is no status column and no suspension semantics — tenants are implicitly active (roadmap.md).

### 3.2 Store

| Field | Type | Semantics |
| ----- | ---- | --------- |
| `id` | UUIDv7 | |
| `tenantId` | UUIDv7 | Never changes. |
| `name` | string | |
| `createdAt` | ms epoch | |

v0 stores are created by provisioning only. Store lifecycle states (closing a store) are **not** a v0 concept — do not invent a status column (roadmap).

### 3.3 Device

| Field | Type | Semantics |
| ----- | ---- | --------- |
| `id` | UUIDv7 | Generated at enrollment. |
| `tenantId` | UUIDv7 | |
| `storeId` | UUIDv7 \| null | Null **only** for the tenant system device (§3.6). Member devices always have a store. |
| `kind` | `member \| system` | Matches the pull-sidecar `DeviceInfo.kind` (api/01-sync §4). |
| `name` | string \| null | Human label ("Kasir depan"). |
| `signingKeyPublic` | base64 (raw 32-byte Ed25519 public key) | Registered at enrollment; **immutable**. Key rotation = revoke + re-enroll as a new device id (keeps chain semantics trivial; rotation-in-place is roadmap). |
| `enrolledAt`, `enrolledBy` | ms epoch, UUIDv7 \| null | `enrolledBy` = acting user; null for the system device. |
| `lastSyncAt` | ms epoch \| null | Updated on every authenticated sync call; feeds the skew window (05-operation-log §6) and the "long-unsynced device" surface (FR-1020). |
| `lastPullCursor` | bigint | Server bookkeeping: the highest `serverSeq` this device has acknowledged pulling. Feeds conflict detection (§8.2). |
| `status` | `active \| revoked` | Terminal at `revoked` (03-state-machines). |
| `revokedAt`, `revokedBy` | ms epoch \| null, UUIDv7 \| null | |

Enrollment and revocation are **online-only server ceremonies** (api/02-auth owns the protocol; device token issuance and storage live there). Invariants:

- Revocation never invalidates operations accepted before it (FR-1019). Ops received after revocation are rejected `DEVICE_REVOKED` (05-operation-log §8).
- The device's Ed25519 **private** key and device token live in `expo-secure-store` only (values < 2 KB). expo-secure-store is encrypted-at-rest storage, **not** a non-extractable-key enclave — app code can read the key back; hardware backing is device-dependent and must never be claimed unconditionally.
- Revocation is a control-plane mutation (api/02-auth §7), recorded in `identity_audit`. There is no revocation op — the directory row is the enforcement truth; clients learn of it via the pull `devices` sidecar into their `device_registry` mirror (api/01-sync §4), where revoked devices remain listed (their pre-revocation signatures must stay verifiable).

### 3.4 Permission — registry entry mirror

The permission registry is **code**: every module manifest statically declares the permission each command/query requires (04-module-contract §5, §6). At deploy/startup the registry is mirrored into a global (non-tenant) table for FK integrity and role-editor UI. Registry entries are never created at runtime and never per-tenant. The entry shape is owned by 02-permissions §3.1 and mirrored here:

| Field | Type | Semantics |
| ----- | ---- | --------- |
| `id` | string | `<module>.<action>`, e.g. `notes.create`. Primary key. |
| `module`, `action` | string | Derived from the id. |
| `scope` | `tenant \| store` | Which scope the check evaluates in — bound to the **permission**, not the command (02-permissions §3.1, §5). |
| `isDangerous` | boolean | Rendered visually distinct in the role editor; granting is a deliberate act. |
| `description` | string | Canonical **English** plain-business-language copy: "what this lets someone do to the business" (PRD-011 §6.4). Label-catalog keys are derived mechanically as `permission.<module>.<action>.name` / `.description` (07-i18n owns the mechanism); never a hardcoded UI string. |

An unrecognised permission id **denies** (FR-1031). Permission *semantics* (evaluation, scoping, denial behavior, the v0 permission matrix) are owned by `02-permissions.md`.

### 3.5 Employee — forward reference

`User.employeeId` (nullable) exists from day one, but the Employee entity, its table, and the FK are **v1** (PRD-007). v0 ships the column always null. Do not build anything against it (roadmap.md).

### 3.6 The system actor and system device

Ops require a non-null `userId` and a signing device (05-operation-log §2.1). Server-originated conflict-detection ops (§8.2) therefore need identities:

- **System actor:** exactly one per tenant. A `User` directory row with `isSystem = true`, `status = active`, `loginIdentifier = null` (the string `"system"` is reserved; user creation rejects it), and no PIN verifier. Cannot log in, cannot be granted roles, never appears in any bundle or switcher, cannot be deactivated.
- **System device:** exactly one per tenant. `kind = system`, `storeId = null`. Its Ed25519 private key is held server-side, never in Postgres (10-db-schema §12). **Storage is a deployment decision, and it is recorded in `08-stack-and-repo.md` §8.1**: v0 reads it from a directory of `system-device-<tenantId>.key` files pointed at by `SYSTEM_KEY_DIR` — set ⇒ conflict detection active, unset ⇒ detection off (the default); a KMS is a later swap behind the same `SystemKeyStore` port. It signs **only** `platform.conflict_detected` ops, built inside the push transaction and chained via `system_device_chain_state` (10-db-schema §3). All its ops carry `source = "system"` and the system actor's `userId`. It has no other emission path: there are no genesis identity ops and no carve-outs to 05-operation-log §9's scope checks.

## 4. Directory identity entities

Users, roles, and grants are **directory data** (§1): server-administered rows, mutated only through online control-plane endpoints — user creation/deactivation/reactivation and PIN-verifier upload (api/02-auth §5.4), role management (02-permissions). **No offline user or role creation, ever.** Every mutation lands in `identity_audit`.

Devices receive identity through the **device bundle** (endpoint owned by api/02-auth §5.2): delivered at enrollment and refreshed by one conditional `GET /v1/devices/me/bundle` per sync loop (`304` steady-state). The bundle contains: the device's store's users (`id`, `name`, `photoMediaId`, `status`, `roleIds`), PIN verifiers **only for that store's users** (verifier minimization), and the tenant's `rolesSnapshot` + `permissionsSnapshot`. Clients write it into the **directory mirror tables** — `users_directory`, `roles_directory`, `user_roles_directory`, `user_pin_verifiers` (own store only), and `device_registry` (from the pull `devices` sidecar, api/01-sync §4) — populated from bundle + sidecar, **never from ops** (10-db-schema §9.5). Offline PIN auth (FR-1010) and offline permission checks (FR-1032) read these mirrors.

Bootstrap: the enrollment bundle is written into the mirror tables **before** any command executes; the permission evaluator (02-permissions §5.2) reads them. The only pre-bundle op — `auth.device_enrolled`, the device's seq-1 genesis — is runtime-emitted and exempt from the evaluator (listed in 02-permissions §4).

### 4.1 User

| Field | Type | Semantics |
| ----- | ---- | --------- |
| `id` | UUIDv7 | |
| `tenantId` | UUIDv7 | A user belongs to **exactly one** tenant, forever (FR-1041). |
| `employeeId` | UUIDv7 \| null | Forward ref (§3.5). Always null in v0. |
| `name` | string | Display name. |
| `loginIdentifier` | string \| null | Control-plane credential name (`POST /v1/auth/login`, with a password). **Globally unique across all tenants, enforced server-side at creation** (api/02-auth §5.4). Null for PIN-only users. `"system"` is reserved. |
| `photoMediaId` | UUIDv7 \| null | Switcher photo, delivered in the bundle (api/02-auth §5.2); bytes fetched via api/03-media. v0 ships **no photo-upload UI** (roadmap.md); the switcher renders an initials fallback. |
| `isSystem` | boolean | §3.6. |
| `status` | `active \| deactivated` | Reversible (03-state-machines). Deactivation revokes access; it **never** removes or hides the user's operations (FR-1004) — history is append-only. |
| `createdAt`, `createdBy` | ms epoch, UUIDv7 | From the creating control-plane call (`identity_audit`). |

A user's PIN credential is **not** a User field. It is a separate directory record — the **PIN verifier** (exact record shape, KDF parameters, and merge rule owned by api/02-auth §5.2–§5.3; not restated here) — stored server-side in `user_pin_verifiers` and distributed to devices only through the bundle, and only for the device's own store's users (verifier minimization). **PIN hash material never appears in the operation log or any op payload**: the log is immutable and replicated forever, which would make a leaked hash an unrotatable secret. PIN change/reset works offline: the emitting device computes the new verifier locally and applies it immediately; the op (`auth.pin_changed` / `auth.pin_reset`, payload `{targetUserId, verifierRef}` — no hash material; api/02-auth §6.2) is the audit record and trigger, and on next online contact the device POSTs the verifier over TLS to `/v1/users/:id/pin-verifier`; other devices receive it via bundle refresh (api/02-auth §6.6). PINs are per-user, not per-device (FR-1009); a reset issues a new verifier, never recovers the old (NFR-1004). Client-local escalating rate limiting applies (FR-1011; `pin_attempt_state`, api/02-auth §6.5).

### 4.2 Role

| Field | Type | Semantics |
| ----- | ---- | --------- |
| `id` | UUIDv7 | |
| `tenantId` | UUIDv7 | |
| `name` | string | Unique per tenant, enforced server-side at creation. |
| `scopeType` | `tenant \| store` | `tenant` roles are granted tenant-wide; `store` roles are granted per store (FR-1025). Evaluation semantics: 02-permissions §5. |
| `isSystemDefault` | boolean | Seeded default (FR-1024); editable, but provenance is preserved. |
| `permissionIds` | string[] | The permission set (relation `role_permissions` in DDL). Ids must exist in the registry; unknown ids contribute nothing at evaluation and **deny** (fail closed). |
| `createdAt` | ms epoch | |

Roles are created and edited only via online control-plane endpoints (02-permissions owns authorization semantics and the role-editor contract); mutations land in `identity_audit` and reach devices via the bundle `rolesSnapshot`. v0 seeds **three** default roles at provisioning (directory rows): `main_owner` (tenant-scoped, all registered permissions), `store_owner`, and `staff` (store-scoped; permission sets owned by 02-permissions §10, §12). The remaining PRD-011 FR-1024 defaults (manager, cashier, …) are seeded when v1 modules exist — their permissions don't exist yet.

### 4.3 Grants

- **UserStoreAssignment** `(userId, storeId)` — the stores a user works at (FR-1003, FR-1006). Server-administered: set via `storeIds` at user creation/edit (api/02-auth §5.4). Drives the switcher: a user appears in a device's bundle — and therefore its switcher — iff `status = active` and assigned to the device's store (api/02-auth §5.1). Clients hold no tenant-wide assignment map; bundle membership *is* their view.
- **UserRoleGrant** — composite `(tenantId, userId, roleId, storeId \| null)`, **no surrogate id** (DDL table `user_roles`, 10-db-schema). `storeId = null` ⇔ tenant-wide grant, valid only for roles with `scopeType = 'tenant'`; a store-scoped grant's `storeId` must be one of the user's assigned stores (server-checked at grant). A user may hold several roles; effective permissions are the **union** of all grants applicable in the evaluation scope (FR-1023). Evaluation semantics: 02-permissions §5.

## 5. Platform entities

### 5.1 Operation

Owned entirely by `05-operation-log.md` (envelope, hashing, chaining, signing, ordering, idempotency, rejection codes). Not redefined here. `Operation.syncStatus`: `local → synced | rejected`, both terminal; rejected ops are kept and surfaced (03-state-machines, 05-operation-log §8).

### 5.2 SyncState (client-local singleton)

One row per device; never synced; consumed by the staleness indicators (api/01-sync §6–7 owns the update protocol; the machine over these guards is 03-state-machines §10). Mirrored exactly by `sync_state` in 10-db-schema §9.3.

| Field | Type | Semantics |
| ----- | ---- | --------- |
| `cursor` | integer | Opaque server pull cursor (= last applied `serverSeq`). Persisted only after a pulled batch is applied atomically. Clients never do arithmetic on it (api/00-conventions §10). |
| `devicesDirectoryVersion` | integer | Last-seen devices-directory version, echoed on every pull; a differing server version delivers the `devices` sidecar (api/01-sync §4). |
| `lastSuccessfulSyncAt` | ms epoch \| null | Drives escalating staleness UI (FR-1134). |
| `lastPushAt`, `lastPullAt` | ms epoch \| null | Diagnostic timestamps: when the last push / pull leg completed (10-db-schema §9.3). Never drive UI guards — `lastSuccessfulSyncAt` does. |
| `lastServerTime`, `lastServerTimeReceivedAt` | ms epoch \| null | Last `serverTime` from a sync response + local receipt time — gives server-relative staleness even under device clock drift (api/01-sync §7). |
| `pushHalted` | boolean | Set on a `CHAIN_BROKEN` rejection (05-operation-log §8); push stays halted until repaired (03-state-machines §10). |
| `syncDisabled`, `syncDisabledReason` | boolean, string \| null | Set on `DEVICE_REVOKED`; all sync stops (03-state-machines §10). |
| `lastSyncError` | string \| null | Last failure, label-catalog code. |
| `backoffUntil` | ms epoch \| null | Sync-loop backoff bookkeeping. |

`pendingOperationCount` and `pendingMediaCount` (PRD-012 §5) are **derived queries**, never stored — stored derivables drift. `pendingOperationCount` = `count(syncStatus = 'local')`; `pendingMediaCount` uses 06-media-pipeline §4's formula — `count(attachedToOperationId != null AND uploadStatus IN ('pending','uploading','failed'))` — orphans do not count.

### 5.3 MediaItem

Captured offline, compressed at capture, uploaded chunked/resumable in the background (PRD-012 §3.7; pipeline mechanics and pruning policy owned by `06-media-pipeline.md`; upload wire protocol by `api/03-media.md`). Field list below = 06 §4's logical contract; `media_items` in 10-db-schema §9.4 mirrors it exactly.

| Field | Type | Semantics |
| ----- | ---- | --------- |
| `id` | UUIDv7 | Client-generated at capture. Referenced from op payloads by id (FR-1138) — ops sync independently of bytes. |
| `tenantId`, `storeId` | UUIDv7, UUIDv7 \| null | `storeId` null for store-less devices (api/03-media §2). |
| `capturedByUserId`, `deviceId` | UUIDv7 | Immutable attribution (FR-1142). |
| `type` | `image \| video \| signature` | |
| `mimeType`, `byteSize` | string, integer | Of the **compressed** artifact. |
| `sha256` | hex(64) | Content hash of the compressed artifact, fixed at capture. The immutability anchor: chunks that don't assemble to this hash are rejected; a media id can never point at different bytes (FR-1143). |
| `capturedAt` | ms epoch | Device clock at capture. |
| `location` | `{lat, lng, accuracyMeters}` \| null | Best available fix; never blocks capture. |
| `localPath` | string \| null (client-only) | Document-directory path (moved out of cache immediately — expo-camera writes to cache). **Null after pruning** (06-media-pipeline §7): local bytes deleted after safe upload (FR-1144); the row and metadata are never deleted. |
| `attachedToOperationId` | UUIDv7 \| null | Backlink, set when an op referencing this media is appended/accepted. Bookkeeping, not signed. |
| `uploadStatus` | `pending → uploading → uploaded \| failed` | `failed` retries back to `uploading`; `uploaded` terminal (03-state-machines). |
| `chunkSize`, `chunksTotal` | integer \| null | Null until the server's init response dictates them (api/03-media §4); clients never assume a chunk size. |
| `uploadAttempts` | integer | Incremented per drain attempt that ends in error; reset on `uploaded`. |
| `nextAttemptAt` | ms epoch \| null | Backoff gate (schedule owned by 03-state-machines §4.1; applied per 06-media-pipeline §5.3). |
| `lastErrorCode`, `lastErrorMessage` | string \| null | From api/03-media §7; persistently failing uploads are surfaced (06-media-pipeline §8, PRD-012 §6). |
| `uploadedAt` | ms epoch \| null | |

Fields above the line `localPath` are **immutable from capture**. There is no update path for them. Resume is **server-authoritative**: the client asks the server which chunks it holds (`GET status` → `receivedChunks`, api/03-media); local progress is display-only.

### 5.4 Conflict

A Conflict is a first-class record that two accepted operations collided at the business level (never at the storage level — FR-1128). Conflict records are themselves **op-sourced**: the server's system device (§3.6) appends `platform.conflict_detected`; the store owner's acknowledgment appends `platform.conflict_acknowledged`. Both replicate through ordinary sync, so every relevant device converges on the same conflict list.

| Field | Type | Semantics |
| ----- | ---- | --------- |
| `id` | UUIDv7 | = `entityId` of the detection op. |
| `tenantId`, `storeId` | UUIDv7, UUIDv7 \| null | `storeId` = the conflicted entity's store (null for tenant-scoped entities) — routes the conflict to the right devices via pull scope. |
| `entityType`, `entityId` | string, UUIDv7 | The conflicted entity. |
| `conflictKey` | string | Which aspect collided (declared per op type, §8.1), e.g. `note.body`. |
| `severity` | `minor \| significant` | §8.3. |
| `status` | `detected → auto_resolved \| surfaced; surfaced → acknowledged` | `detected` is transient (classification happens in the same fold step); at rest a conflict is `auto_resolved`, `surfaced`, or `acknowledged` (03-state-machines). |
| `opAId`, `opBId` | UUIDv7 | The colliding ops, canonical order (A before B). |
| `detectedAt` | ms epoch | Server time of detection. |
| `acknowledgedBy`, `acknowledgedAt`, `acknowledgementOpId` | nullable | From the acknowledgment op. |

Acknowledgment is a decision record, not an automatic data change: the owner sees both ops and, if a correction is needed, issues it as a **new ordinary operation** (e.g. edits the note again). The system never rewrites anything (FR-1131, 05-operation-log §1).

## 6. Platform op types (v0 registry)

Registered per 04-module-contract §3 (`.strict()` Zod payloads, mandatory `reversal` docs — payload field detail lives in the module manifest in `@bolusi/core`; this table is the authoritative list of **platform** op types). The `auth` module's op registry (enrollment genesis, sessions, PIN lifecycle, denials) is owned by **api/02-auth §6.2** and is never restated here; the `notes` module's op types are in §9. No other module registers op types in v0.

| Type | entityType / entityId | Payload (summary) | Emitted by |
| ---- | --------------------- | ----------------- | ---------- |
| `platform.conflict_detected` | `conflict` / new conflict id | entityType, entityId, conflictKey, severity, opAId, opBId | **system device only** — built, signed, and sequenced server-side inside the push transaction (10-db-schema §3); rejected from all other devices (`SCOPE_VIOLATION`). `storeId` = the conflicted entity's store (null for tenant-scoped entities). |
| `platform.conflict_acknowledged` | `conflict` / conflict id | note \| null | owner command `acknowledgeConflict` (permission `platform.conflict_acknowledge` — 02-permissions §11). `storeId` = the conflict's `storeId`. |
| `platform.user_locale_changed` | `user_pref` / acting user id | `{ locale }` (Locale type owned by 07-i18n §1.1) | command `platform.setLocale` — any active user, for themselves (permission `platform.set_locale` — 02-permissions §11). Tenant-scoped (`storeId = null`): the preference follows the user to every device. No conflict declaration (canonical-order LWW). |

Which permission each command requires is owned by `02-permissions.md`.

## 7. Projection pattern (description)

The rules — determinism, entity-scoped writes, canonical-order folding, out-of-order re-fold, rebuild, watermarks — are owned by 04-module-contract §4 and not restated. What this doc pins:

- A projection table is **always disposable**: droppable and rebuildable from the log with zero information loss. If a projection column cannot be recomputed from ops, it does not belong in a projection table.
- Projection tables exist twice with one applier: Postgres (server read models, scope validation §4) and SQLite (device read models), written via the dialect-neutral `ProjectionDb` subset.
- v0 projection tables: `conflicts`, `user_prefs` (platform module); `auth_sessions`, `pin_lockout_events`, `auth_permission_denials` (auth module — op registry api/02-auth §6.2; denial shape 02-permissions §7); `notes` (reference module). DDL: 10-db-schema.
- The client directory mirrors (§4) are **not** projections: they are populated from the bundle and the pull `devices` sidecar, never fed by ops, and are refreshed — not rebuilt — from the server.
- Per-module watermarks (`applied_server_seq`, `applied_local_seq`) track progress; snapshots are deferred to v1 (04-module-contract §4.3).

## 8. Conflict semantics (v0)

### 8.1 Conflict declaration

An op type that can collide declares, in its registry entry (extends 04-module-contract §3):

```ts
conflict: { key: 'note.body', severity: 'minor' }   // optional field
```

Ops without a `conflict` declaration never generate Conflict records. Two ops conflict only when they share (`entityId`, `conflict.key`).

### 8.2 Detection — server vantage, two rules

Detection runs **on the server only**, at op acceptance, inside the push transaction. The server is the single deterministic vantage point (client-local detection would diverge per replica); results reach every device as `platform.conflict_detected` ops through normal pull. Fresh devices rebuilding from cursor 0 replay the same conflict ops — convergence holds.

**Rule 1 — concurrent edit (generic).** On accepting op `O` with conflict key `K` on entity `E`: `O` conflicts with every already-accepted op `P` on (`E`, `K`) where `P.deviceId ≠ O.deviceId` **and** `serverSeq(P) > lastPullCursor(O.device)` at acceptance time. Reading: O's device had not pulled P when it pushed O, so O's author acted without knowledge of P — a genuine concurrent edit. This catches both arrival orders (whichever device syncs later, the rule fires on its push). At most one Conflict record per unordered op pair (dedupe on `(opAId, opBId)`).

**Rule 2 — invariant checks (registered, bespoke).** Named cross-entity checks evaluated at acceptance. v0 registers exactly one: **`notes:edit_after_archive`** — an accepted `notes.note_body_edited` whose note is already archived at fold time (the editing device had not seen the archive) → `significant`. (The server never rejects for business reasons — rejection codes are closed, 05-operation-log §8 — it accepts and flags.) v1 examples (negative stock, contradictory status transitions — PRD-012 §3.5) slot in here; they are **not** built in v0. Identity uniqueness is *not* a Rule-2 case: `loginIdentifier` is globally unique, enforced server-side at creation (§4.1) — identity mutations are online-only, so no offline collision can exist. The last-admin guard is likewise not a Conflict: it is a server endpoint check, `409 LAST_ADMIN_PROTECTED` (api/02-auth §5.4).

### 8.3 Minor vs significant — what v0 means by them

| Severity | Meaning | Lifecycle | v0 cases |
| -------- | ------- | --------- | -------- |
| `minor` | Canonical-order fold already produced a correct, nothing-lost outcome. Recorded for reporting only; nobody is asked anything. | `detected → auto_resolved` (terminal) | Concurrent `notes.note_body_edited` on the same note from two devices (conflict key `note.body`): the canonically-later body wins the projection (LWW); the earlier author's text survives in the log. Recorded as a Conflict row, queryable in audit. |
| `significant` | The fold produced an outcome a human must see: a business invariant broke or an intent was invalidated. A store owner must see it. | `detected → surfaced → acknowledged` | Edit-after-archive: a body edit accepted for a note that was archived concurrently (Rule-2 check `notes:edit_after_archive`, §8.2). |

Pinned defaults: **an op type's declared severity is static** — v0 has no payload-dependent severity (e.g. "small vs large adjustment" is a v1 concern for inventory). Surfaced conflicts appear on store-owner devices (permission `platform.conflict_view`, 02-permissions §11) until acknowledged; acknowledgment is the `platform.conflict_acknowledged` op (§5.4). Nothing auto-resolves silently *by a rule the owner cannot see* — `auto_resolved` conflicts are still queryable records (FR-1131 honored by keeping even the minor ones).

## 9. Reference module: notes

Deliberately trivial; exists to prove the contract (04-module-contract §8). Store-scoped: a note belongs to one store; all its ops carry that `storeId`.

**Note (projection):**

| Field | Type | Semantics |
| ----- | ---- | --------- |
| `id` | UUIDv7 | = `entityId`. |
| `tenantId`, `storeId` | UUIDv7 | `storeId` non-null. |
| `title` | string | Set at creation; v0 has no title edit (keeps op surface minimal). |
| `body` | string | Last body in canonical order. |
| `mediaId` | UUIDv7 \| null | One attachment (exercises the media pipeline). Introduced by payload `schemaVersion: 2`. |
| `mediaSha256` | 64-char lowercase hex \| null | The SIGNED hash of the attachment's final bytes, from the v3 payload's `mediaRef` (06 §3.2). Non-null exactly when the note was created at v3 **with** an attachment — a v2 note has a `mediaId` and a null hash, and that asymmetry is why the render path must distinguish them (06 §6). |
| `mediaMime` | `image/jpeg` \| `image/png` \| null | From the same v3 `mediaRef`. Null for v1/v2 notes. |
| `archived` | boolean | Set by `note_archived`; no unarchive in v0. |
| `edit_count` | integer | Count of applied `note_body_edited` ops. **Testability column** (testing-guide §3.2): a pure-LWW projection cannot reveal double-application; the convergence oracle digests it. In both engines' DDL (10-db-schema). |
| `createdBy`, `createdAt` | UUIDv7, ms epoch | From the creation op. |
| `lastEditedBy`, `lastEditedAt` | UUIDv7, ms epoch | From the canonically-latest body edit (or creation). |

**Op types** (registry in the `notes` manifest):

| Type | schemaVersions | Payload | Conflict decl |
| ---- | -------------- | ------- | ------------- |
| `notes.note_created` | 1: `{title, body}` · 2: `{title, body, mediaId: string \| null}` · **3 (current): `{title, body, mediaRef: MediaRef \| null}`** | applier handles all three forever | — |
| `notes.note_body_edited` | 1: `{body}` | | `{key: 'note.body', severity: 'minor'}` |
| `notes.note_archived` | 1: `{}` | | — |

The version bumps on `note_created` are deliberate: they are the mid-history schema migration the exit criteria require (04-module-contract §8). **v1→v2** added the bare `mediaId`. **v2→v3** replaced it with the whole signed `mediaRef` (`zMediaRef`, `packages/schemas/src/media.ts` — `{mediaId, sha256, mime, type, sizeBytes, capturedAt, location, userId, deviceId}`, strict), because a bare id is not verifiable: a device that PULLS someone else's note must be able to check the downloaded bytes against a hash the author signed (06 §6). The applier folds `mediaRef.sha256`/`.mime` into the projection's `mediaSha256`/`mediaMime`; a v2 note keeps its `mediaId` with both null, forever.

**Every foldable version needs a retained payload schema.** 05 §8 defines `SCHEMA_INVALID` as "payload fails registry Zod for (`type`, `schemaVersion`)" — the pair, not the type alone. Retaining only the current schema means an op declaring an older version is accepted unvalidated and throws at fold instead (task 127). "The applier handles it" is a fold-time contract, not a validation one. Commands (`createNote`, `editNoteBody`, `archiveNote`) and queries (`listNotes`, `getNote`) follow 04-module-contract §5–6; permissions `notes.create`, `notes.edit`, `notes.archive`, `notes.read` (matrix: 02-permissions). Editing a note that is archived in the local projection is a command-level denial (`DomainError`), not a projection rule; the concurrent case — an edit appended by a device that had not yet seen the archive — is caught server-side by the registered Rule-2 check `notes:edit_after_archive` (§8.2).

## 10. Invariants (testable, numbered)

**These are contracts, and the section title is a promise** (decision D15b). Every **live** invariant
has exactly one owner: a test whose **title carries the invariant id verbatim**, or — when the
universal claim is genuinely not yet shipped — a row in
`packages/test-support/src/invariant-pending-allowlist.json` naming the owing task. The gate is
`packages/test-support/src/invariant-meta.test.ts`, which rides the SEC-META-01 machinery
(`sec-meta.ts`, `INVARIANT_SCHEME`) rather than duplicating it. **To find an invariant's test, grep
its id.** Adding an invariant without an owner fails the gate; so does removing its owning title.

**On `FR-####` citations (decision D15a).** An `FR-####` beside a rule is **provenance** — a pointer
back to the PRD that motivated it — **not** a discharge contract. The **spec text is the
requirement**, and tasks discharge **spec sections, not FR ids**; nothing tracks FR→owner and
nothing is meant to. (PRDs are *stale input, not ground truth* — CLAUDE.md §1 — so a traceability
contract anchored in them would invert the doc hierarchy.) Invariant ids `I-#` are the opposite:
spec-native, universally quantified, and gated per the paragraph above. Do not infer from an
`FR-####` that some task cites it back.

| # | Invariant | Owner — task · test titling the id |
| - | --------- | ---------------------------------- |
| I-1 | A user belongs to exactly one tenant, for life. No cross-tenant user, no cross-tenant access path (FR-1040/41). | 05 · `db-server/test/sec-tenant-02-enforcement.test.ts` (RLS closes the cross-tenant read path) |
| I-2 | Deactivating a user preserves every operation they performed; reactivation restores access without any history gap (FR-1004). `active ↔ deactivated` is the only user transition. | 07 · `server/test/integration/oplog/pipeline.test.ts` (the pipeline gates on membership, never status) |
| I-3 | The last active user holding the tenant-administration permission cannot be deactivated; the system actor counts for nothing here (PRD-011 §7). Server-endpoint-enforced: `409 LAST_ADMIN_PROTECTED` (api/02-auth §5.4). | 13 · `server/test/identity/users.test.ts` |
| I-4 | A device belongs to exactly one (tenant, store) pair; `revoked` is terminal; pre-revocation ops remain valid and verifiable forever (FR-1019). | 13 · `server/test/security/sec-dev.test.ts` (SEC-DEV-03). The `(tenant, store)` clause is additionally structural — the `devices` NOT NULL/CHECK constraints in `db-server/test/ddl-constraints.test.ts` |
| I-5 | Every entity row in every tenant table carries `tenantId` (FR-1038); enforcement is the two-layer tenancy scheme in 10-db-schema §RLS. | 05 · `db-server/test/sec-tenant-01-rls-coverage.test.ts` (catalog walk over **every** tenant table) |
| I-6 | MediaItem capture metadata (`sha256`, `capturedAt`, `location`, `capturedByUserId`, `deviceId`, `type`) is immutable from capture; a media id can never resolve to different bytes (FR-1142/43). | 19 · `server/test/integration/media/sec-media.test.ts` (SEC-MEDIA-02; route walk proves no mutation endpoint exists) |
| I-7 | Conflict records are never deleted; `acknowledged` and `auto_resolved` are terminal; an owner decision is expressed only as a new operation (§5.4). | 17 · `core/test/platform/commands.test.ts` |
| I-8 | Projections are disposable; any projection table can be dropped and rebuilt from the log byte-identically (FR-1116, FR-1119). | 08 · `core/src/projection/rebuild.test.ts` |
| I-9 | `loginIdentifier` is globally unique across all tenants and role names are unique per tenant — both enforced server-side at creation (§4). Identity mutations are online-only, so no offline collision path exists. | 13 · `server/test/identity/users.test.ts` (the `login_identifier` UNIQUE index, surfaced as `409`) |
| I-10 | A store-scoped role grant's `storeId` is one of the user's assigned stores; `scopeType = 'tenant'` grants carry `storeId = null`. Violations deny at evaluation (fail closed). | 09 · `core/test/authz/evaluate.test.ts` (the store→tenant escalation guard) |
| I-11 | The system actor and system device exist exactly once per tenant, cannot log in / enroll users, and are the only permitted source of `platform.conflict_detected` ops. | 07 · `server/test/integration/oplog/pipeline.test.ts` (any non-system source is `SCOPE_VIOLATION`) |
| I-12 | Retired — tenant suspension is deferred (roadmap.md); v0 tenants are implicitly active and no status column exists (§3.1). The number is reserved to keep cross-references stable. | **retired — no owner is correct**; excluded from the gate's denominator |
| I-13 | PIN hash material never appears in the operation log or any op payload; verifiers travel only over the control plane (TLS) and the device bundle, scoped to the user's own stores (§4.1). | **28** (allowlisted, openly owed). Task 14 proves this **per-case** (`pin-flows.test.ts` asserts specific payloads carry no verifier); the **universal** scan over every pushed payload is SEC-AUTH-09 leg 2. **Per-case ≠ universal**, so the per-case test deliberately does *not* title I-13 |

## 11. Out of v0 (do not build here)

Employee entity + HR link (v1) · store lifecycle states · tenant suspension (`Tenant.status` — §3.1) · cross-store pull scope, cursors, and the in-app store switcher (FR-1034, OQ-1103; v0 rule: `ctx.storeId` = the enrolled device's store, always) · payload-dependent conflict severity, stock/negative-inventory conflict rules (v1 inventory) · projection snapshots (04-module-contract §4.3) · key rotation-in-place · per-user push preferences & targeting (v0 pushes address devices, with per-category client-side muting — api/04-push; FR-1149/50) · user photo upload/management UI (`photoMediaId` exists in the directory from day one, §4.1; the switcher renders initials until v1) · local op-log history retention window (OQ-1102; v0 rule: devices retain everything — 05-operation-log). All tracked in roadmap.md.
