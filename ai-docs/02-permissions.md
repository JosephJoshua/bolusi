# 02 — Permissions & Authorization

> **Owns:** the authorization model — permission id format, the permission registry (shape + complete v0 contents), scope evaluation, fail-closed rules, offline evaluation, permission-change propagation and cache invalidation, denial logging, data-level gating, the v0 default roles, and the authz matrix. Authentication (PIN, device tokens, enrollment, revocation transport) lives in `api/02-auth.md`; the command/query runtime that calls this model lives in `04-module-contract.md`; op envelope facts live in `05-operation-log.md`; tenant isolation at the data layer (RLS + `forTenant()`) is infrastructure, specified in `10-db-schema.md` §6 and `08-stack-and-repo.md` §3.2 — it is below authorization, not part of it.
> **Change control:** change this doc first, then the code. Any new permission, new role, new denial reason, or authz-matrix change is a CLAUDE.md §6 red flag — **stop and ask** before implementing.

## 1. Model

RBAC with two sources of truth:

| Thing | Lives where | Changes how |
| ----- | ----------- | ----------- |
| **Permissions** (the vocabulary) | Static registry, assembled from module manifests at startup. Code, versioned with the app build. | App release. Never at runtime, never per tenant. |
| **Roles + role grants** (who holds what) | Server-administered **directory data** (control plane, `api/02-auth.md` §1). Each device holds a mirror in its client directory tables, seeded by the enrollment bundle and refreshed via conditional `GET /v1/devices/me/bundle` (§6). | Online identity endpoints only (`api/02-auth.md` §5.4) — never offline, never via ops. Devices pick changes up on their next bundle refresh (§8). |

A user's effective permission set is the **union** over all their matching role grants (FR-1023). There are **no wildcards, no implicit admin, no superuser flag** — `main_owner` is an ordinary role holding every permission explicitly (§10). A grant that is not written down does not exist; a check that cannot be resolved denies (FR-1031).

Boundaries — what this doc is NOT:

| Concern | Owner |
| ------- | ----- |
| Is this device trusted / enrolled / revoked? | `api/02-auth.md` + 05 §9 (transport + push validation) |
| Is this human who they claim (PIN)? | `api/02-auth.md` |
| How do users, roles, and PIN verifiers reach a device? | Enrollment bundle + bundle refresh, `api/02-auth.md` §5 |
| Can this query physically reach another tenant's rows? | Data layer: `forTenant()` wrapper + Postgres RLS (D3, FR-1039) — `10-db-schema.md` §6 + `08-stack-and-repo.md` §3.2 |
| Which ops does a device receive? | Sync pull scope, `api/01-sync.md` §4.1 |
| **May this user run this command / see this field?** | **This doc.** |

## 2. Permission identifiers

- Format: **`<module>.<action>`** — regex `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`.
- `<module>` MUST equal the owning module's manifest id (04 §1: the module id prefixes op types and permissions). The auth module's ids are therefore `auth.user_create`, `auth.device_revoke` — never `users.create`.
- `<action>` is snake_case, **present tense**, verb-first or `<entity>_<verb>` (`notes.create`, `auth.user_reset_pin`). Contrast op types, which are past tense (`notes.note_created`, 05 §2.1) — a permission names a capability, an op names a fact.
- Ids are **immutable once shipped**: role grant lists and denial ops reference them as strings in an append-only log. Renaming = registering a new id + a migration decision (red flag). An id is never reused for a different capability.
- Lint (CI-enforced): a module manifest may declare permissions only under its own prefix; a command/query may only require a permission declared by its own module (v0 — cross-module permission use is a v1 decision).

## 3. Registry

### 3.1 Entry shape

| Field | Type | Semantics |
| ----- | ---- | --------- |
| `id` | string | `<module>.<action>`, §2. Map key in the manifest. |
| `module` | string | Derived from id. |
| `action` | string | Derived from id. |
| `scope` | `'tenant' \| 'store'` | Which scope the check evaluates in (§5). Bound to the **permission**, not the command — one source of truth for scope. |
| `isDangerous` | boolean | Grants that should feel like a decision, not a checkbox (PRD-011 §5, §6.4). Drives visual distinctness in the role editor (design-system owns the rendering; this flag owns the semantics). |
| `description` | string | Canonical **English** plain-business-language copy: what the permission lets someone do **to the business**, written for a shop owner, not an engineer ("Can reset another employee's PIN", not "writes user_pin_verifiers"). This doc's tables (§11) are the canonical source. |

User-facing display of name/description goes through the label catalog under **derived keys** `permission.<module>.<action>.name` / `permission.<module>.<action>.description` (ID + EN). These are 4-segment keys under the reserved `permission` namespace — 07-i18n §3.1 documents the derived-key exception that permits them. The registry `description` is the canonical English source those catalog entries are authored from, and the runtime fallback if a catalog key is missing.

### 3.2 Declaration & assembly

Each module manifest declares a `permissions` block (this extends the 04 §1 `defineModule` shape; 04 is the owning doc for the shape and must list the key):

```ts
permissions: {
  'notes.archive': {
    scope: 'store',
    isDangerous: false,
    description: 'Can archive a note, removing it from the store’s active list.',
  },
},
```

Assembly rules (startup, both runtimes):

1. Registry = merge of all registered modules' `permissions` blocks.
2. Duplicate id across modules ⇒ **startup failure** (not a warning).
3. Every `permission` referenced by any command (04 §5) or query (04 §6) MUST resolve to a registry entry ⇒ else startup failure.
4. Id prefix must match the declaring module id ⇒ else startup failure.

The registry is identical on client and server for a given build (same shared package). Version skew between builds is handled by fail-closed evaluation (§6): an id absent from *this build's* registry can never be granted, and a grant list naming an unknown id contributes nothing.

## 4. Enforcement — the single point

**The only control is step 2 of the command/query runtime** (04 §5.1: `ctx.requirePermission(command.permission)` — fail closed; queries are checked identically, 04 §6). Everything else is convenience:

| Layer | Role |
| ----- | ---- |
| Command runtime step 2 / query runtime | **Control.** No command or query executes unchecked. The V2 agent calls commands directly and never sees a button (FR-1028) — this is the layer that stops it. |
| UI hiding (`usePermission(id)` hook, same evaluator) | Convenience only. A hidden button MUST also be a denied command. Never gate anything on UI state. |
| Server route handlers | No permission logic on module routes — v0 exposes no command routes (04 §2); when server queries arrive (v1 reporting), they run the same query runtime. The identity control-plane endpoints (`api/02-auth.md` §5.4) are not module routes: they enforce this registry's permissions server-side against the server directory before mutating it (transport owned there; ids, scopes, and matrix owned here). |
| Sync push validation | Not a permission check, with one named exception. 05 §9 validates identity/scope consistency and device trust; the single v0 permission-validated case is the privileged PIN ops (below). |

`requirePermission` throws `DomainError('PERMISSION_DENIED')` (04 §5.3) and emits a denial op (§7). The error surfaces via label catalog key `core.errors.PERMISSION_DENIED` (07-i18n §4.2) — a denial is **always an explicit error, never an empty result** (FR-1036: an empty result leaks "the store exists and is quiet").

**Runtime-emitted exceptions.** Exactly **five** op types are appended by the runtime itself without passing through a command (and therefore without a permission check):

- `auth.user_switched` and `auth.session_ended` — authentication precedes authorization (FR-1014).
- `auth.permission_denied` — §7; a denial log must not itself be deniable.
- `auth.device_enrolled` — the genesis op (seq 1), emitted at enrollment **before** the bundle is written into the directory tables; exempt from the evaluator by the bootstrap rule (§6).
- `auth.pin_locked_out` — a lockout record must not depend on the locked-out user's permissions (api/02-auth §6.5).

No other op type may bypass the command layer; the sanctioned list is pinned in 04 §5 and lint-enforced.

**Server-side residual risk (v0, accepted — with one named exception).** The rejection-code set in 05 §8 is closed and contains no permission code: apart from the exception below, the server does NOT re-verify authorization on pushed ops. A tampered client with a valid enrolled device could emit ops its user was never permitted to make; they arrive signed and fully attributed. This matches the threat model (PRD-011 §8: insiders, attribution over perimeter) — the response is audit + device revocation, not silent rejection. Re-checking at push time against *current* roles would falsely reject legitimate offline work made before a role change; checking against *historical* roles requires folding role state at `op.timestamp`. **General server-side permission audit of pushed ops (flag, never reject — like `clockSkewFlagged`, 05 §6) is a v1 hardening item — see roadmap.md.** Do not add a rejection code for this without changing 05 first.

**Named v0 exception — privileged PIN ops.** Pushed ops of type `auth.pin_changed`, `auth.pin_reset`, and `auth.pin_lockout_cleared` ARE permission-validated server-side at push, against the server directory (the actor's roles per bundle-truth at receipt). A violation is rejected `SCOPE_VIOLATION` — an existing 05 §8 code; no new code exists for it. 05 §9 lists this as its one v0 push-validation extension. Why these three and nothing else: a forged PIN reset or lockout clear is impersonation power — exactly the privilege escalation the fraud model exists to prevent — and for these ops the false-rejection risk accepted above is a price worth paying.

## 5. Scope evaluation

### 5.1 Data model

| Entity | Fields (authz-relevant) | Notes |
| ------ | ----------------------- | ----- |
| `Role` | `id` (UUIDv7), `tenantId`, `name`, `permissionIds: string[]`, `scopeType: 'tenant' \| 'store'`, `isSystemDefault: boolean` | PRD-011 §5 said `global \| store`; renamed **`tenant`** — nothing is global in a multi-tenant system. Roles are server-administered directory rows (api/02-auth §5.4), mirrored client-side in `roles_directory`. |
| `UserRoleGrant` | Composite key (`tenantId`, `userId`, `roleId`, `storeId: UUID \| null`) — **no surrogate id**. Server table `user_roles`; client mirror `user_roles_directory`. | `storeId = null` ⇔ tenant-wide grant, valid **only** for roles with `scopeType: 'tenant'`. Store-scoped roles require a non-null `storeId`. "Manager at Toko Jayapura" = one grant; a store_owner with three stores = three grants. |

Users, roles, and grants are **directory entities**: created and mutated only via the online identity endpoints owned by `api/02-auth.md` (§5.4), and distributed to devices via the enrollment bundle + bundle refresh (§6). There are no user/role mutation op types — the auth op registry (api/02-auth §6.2) contains none. Their **authorization semantics** — who may call those endpoints, and how grants evaluate — are owned here.

### 5.2 Algorithm (normative)

```ts
hasPermission({ userId, tenantId, storeId /* evaluation store — v0: the device's store, always */, permissionId })
  → { allowed: true } | { allowed: false; reason: DenialReason }
```

1. `permissionId` resolves in this build's registry — else DENY `unknown_permission`.
2. Acting user exists in the `users_directory` (bundle-fed, §6), `user.tenantId === tenantId`, `user.status === 'active'` — else DENY (`user_inactive` / `tenant_mismatch`).
3. If `registry[permissionId].scope === 'store'`: `storeId` MUST be non-null — else DENY `missing_scope`. If `scope === 'tenant'`: `storeId` is ignored.
4. Collect the user's grants (`user_roles_directory` rows) that **match the scope**:
   - `scope: 'tenant'` → only grants with `grant.storeId = null` count. A store-scoped grant can NEVER satisfy a tenant-scoped permission, even if the role's grant list contains it.
   - `scope: 'store'` → grants with `grant.storeId = ` the evaluation `storeId`, plus tenant-wide grants (`grant.storeId = null`) — a tenant-wide grant is valid in every store of the tenant (FR-1037: main owner sees all stores, only their tenant).
5. Drop malformed/unresolvable grants silently-for-evaluation (they contribute nothing): missing role, store-scoped role with null `grant.storeId`, role whose `tenantId` mismatches.
6. ALLOW iff any surviving grant's role has `permissionId` in `permissionIds`; else DENY `not_granted`.
7. Any thrown error during evaluation ⇒ DENY `evaluation_error`. Fail closed is unconditional.

Union semantics (FR-1023) fall out of step 6. **v0 rule (normative): the evaluation `storeId` (`ctx.storeId`) is the enrolled device's store — always.** The runtime stamps it into `ctx` (04 §5.1) and into every op it appends (05 §2.1), so an op's recorded scope always equals the scope it was authorized in. The FR-1034 store switcher and a multi-store active-store context are v1 — roadmap.md.

### 5.3 Fail-closed table

| Condition | Result |
| --------- | ------ |
| Permission id not in this build's registry | DENY `unknown_permission` |
| Acting user absent from `users_directory` | DENY `user_inactive` |
| `user.status !== 'active'` | DENY `user_inactive` |
| User's tenant ≠ evaluation tenant | DENY `tenant_mismatch` |
| Store-scoped permission, `storeId` null/absent | DENY `missing_scope` |
| Grant references deleted/unknown role | Grant ignored → typically DENY `not_granted` |
| Grant list contains an id unknown to this build | That id inert (cannot allow anything); rest of role unaffected |
| No matching grant's role contains the id | DENY `not_granted` |
| Evaluator throws (corrupt row, any bug) | DENY `evaluation_error` |
| Handler-level restriction violated (§5.4) | DENY `restriction_violated` |

### 5.4 Handler-level restrictions (anti-escalation)

Some grants are store-scoped but touch tenant-level entities (users span stores). The permission check gates entry (§5.2 on-device for commands; the same registry evaluation server-side for the identity endpoints). These **normative restrictions run inside the handlers**: rules 1–5 in the server identity endpoints (`api/02-auth.md` §5.4 — user, role, and grant mutations are online-only), rule 6 in the offline PIN command handlers. Endpoint violations return the stated HTTP error; rules 1–3 return `403 PERMISSION_DENIED`, reason `restriction_violated`:

1. **Subset rule (no privilege escalation via grants):** a user may only grant a role whose effective permission set, in the target scope, is a subset of the granter's own effective permission set in that scope. A store_owner can never grant main_owner.
2. **Tenant-grant rule:** creating a tenant-wide grant (`storeId = null`) requires holding `auth.role_manage` via a tenant-wide grant.
3. **Store-boundary rule:** a holder of store-scoped `auth.user_*` / `auth.device_*` permissions may only affect users and devices of the stores they are granted: created users' store memberships ⊆ the holder's granted stores; deactivation and PIN reset only for users whose store memberships ⊆ the holder's granted stores.
4. **Last-admin guard (endpoint guard):** the server refuses any directory mutation that would reduce the tenant's count of *tenant admins* (active users holding `auth.role_manage` via a tenant-wide grant) to zero — `409 LAST_ADMIN_PROTECTED`. This covers deactivating the last admin (the main owner cannot deactivate themselves), removing the last tenant-wide `auth.role_manage` grant, and editing a role's grant list while it backs the last such grant (PRD-011 §7). Every mutation that could trip it is an online endpoint call, so the guard is a plain server-side check — there is no offline race and no projection-level guard.
5. **Role deletion:** blocked while any grant references the role — `409 ROLE_IN_USE` (PRD-011 §7: dangling role references end in no access or unchecked access).
6. **PIN-command targeting (offline commands):** changing a PIN via permission `auth.pin_change` may target only the acting user; an owner PIN reset (permission `auth.user_reset_pin`) and a lockout clear (permission `auth.pin_unlock`) may target only users present in the device's `users_directory`. Violations deny `DomainError('PERMISSION_DENIED')`, reason `restriction_violated`. Command surfaces are owned by api/02-auth §6.3; the forged-op path is closed by the §4 push-validation exception.

## 6. Offline evaluation

Permission checks MUST work fully offline (FR-1032) and be cheap enough to run on every command and every query without anyone being tempted to cache results ad hoc (NFR-1002):

- **Registry** = code in the app build. Zero I/O.
- **Roles + grants + user status** = rows in the client **directory tables** — `users_directory`, `roles_directory`, `user_roles_directory` (10-db-schema §9.5). They are seeded from the **enrollment bundle** at enrollment and refreshed by the sync loop's conditional `GET /v1/devices/me/bundle` (api/02-auth §5.2; one conditional check per loop, `304` in steady state) — **never from ops**. The bundle carries the device's store's users (id, name, photoMediaId, status, grants — the `UserRoleGrant` tuples, §5.1), the tenant's `rolesSnapshot` + `permissionsSnapshot`, and PIN verifiers for that store's users only (verifier minimization, api/02-auth §5.1). A device therefore holds the full directory slice for every user it may meet: its own store's.
- **Bootstrap rule:** the enrollment bundle is written into the directory tables **before any command executes** (api/02-auth §4.1); the evaluator reads those tables from the first command on. The only op that precedes the bundle is `auth.device_enrolled` — runtime-emitted and exempt from the evaluator (§4).
- `hasPermission` is **synchronous**: it reads an in-memory effective-set snapshot, memoized per `(userId, storeId)`.
- **Memo invalidation is event-driven, never TTL:** the snapshot is dropped exactly when (a) a bundle refresh writes any directory table, or (b) the active user switches. A time-based cache is stale authorization; forbidden (NFR-1002's warning is the reason this rule exists). (`storeId` is fixed per device in v0, §5.2 — the memo key carries it for v1 multi-store.)
- **Pre-auth exemption:** the user switcher (PRD-011 §6.1) renders before anyone is authenticated. It reads the `users_directory` rows directly (id, name, photoMediaId, status) and is exempt from query permission checks **by design and by allowlist** — it is the only such surface in v0. Anything else pre-auth is a spec change (red flag).

A device that is offline evaluates against its last-fetched bundle. That is the correct behavior, and it has the documented consequence that revocations are *eventually* effective (§7 of PRD-011): a user deactivated while a device is offline keeps working on that device until its next bundle refresh. Physical repossession is the urgent-revocation control, not software.

## 7. Denial logging — denials are operations

**Decision:** permission denials are recorded as **operations** (FR-1045), not as a side log.

*Why ops:* denials must reach owners across devices; the op log is the only sync channel (api/01-sync §8 — sync moves ops, nothing else), it is tamper-evident, and it attributes denials to user+device+time for free. A parallel denial channel would be new machinery with weaker guarantees. *Rejected alternative:* local-only table + bespoke upload — loses tamper evidence, adds a second sync path, dies with a lost device.

| Property | Value |
| -------- | ----- |
| Op type | `auth.permission_denied` |
| Emitted by | The permission runtime itself, at the single enforcement point (§4). Bypasses the command layer (it IS the command layer); one of the five runtime-emitted types (§4). Never recursive: its emission is never permission-checked. |
| `entityType` / `entityId` | `permission_denial` / fresh UUIDv7 per op (each denial its own entity — applier inserts exactly one row, satisfying the entity-scoped-write rule, 04 §4.1). |
| `storeId` (envelope) | The device's store — all auth ops are store-scoped (api/02-auth §6.2). The **evaluation** scope travels in the payload as `scopeStoreId` (null for tenant-scope checks). |
| `source` / `agentInitiated` | Mirror the denied attempt's values (a denied agent attempt must be visible as one — ARCH-001 §9.3). |
| Payload (all keys always present) | `{ permissionId: string, surface: 'command' \| 'query', target: string /* command/query name */, reason: DenialReason, scopeStoreId: uuid \| null, suppressedRepeats: int ≥ 0 }` |

This section owns the `auth.permission_denied` payload shape; the auth op registry (api/02-auth §6.2) and 01-domain-model §6 reference it.

`DenialReason` enum (closed set; extending it is a red flag): `not_granted | unknown_permission | missing_scope | user_inactive | tenant_mismatch | restriction_violated | evaluation_error`.

**Throttle (flood control):** at most one denial op per `(userId, permissionId, target)` per **5-minute window** per device. First denial in a window emits immediately; repeats increment an in-memory counter that is flushed into the next emitted op's `suppressedRepeats`. Counter state is memory-only and lost on app restart — accepted (the signal is the pattern, not the exact count). Live queries additionally must not spin: a live query subscription that receives `PERMISSION_DENIED` **terminates** and does not auto-retry until the effective permission set changes (§8).

**Projection + read path:** denials project into `auth_permission_denials` (one row per op: id, tenantId, storeId — the envelope's device store, scopeStoreId — from the payload, userId, deviceId, timestamp, permissionId, target, reason, suppressedRepeats). Read via auth query `listPermissionDenials`, permission `auth.audit_view`, cursor-paginated (04 §6). Owner-facing "repeated attempts" reporting UI is v1; the data is complete from day one. Directory changes (users, roles, grants) are audited by the control plane's `identity_audit` log (api/02-auth, 10-db-schema §7) — FR-1046 is satisfied by the two surfaces together.

## 8. Permission-change propagation & invalidation

1. **Effective next bundle refresh (FR-1033).** A user/role/grant change is an online directory mutation (api/02-auth §5.4); it takes effect on a device when that device's next bundle refresh (§6) writes the changed rows into its directory tables. On the device that initiated the change the effect is near-immediate: it refreshes its bundle right after the mutating call succeeds.
2. **Recompute.** Any bundle refresh that changes a directory table invalidates the memo (§6) and recomputes the current user's effective set.
3. **The effective permission set is a dependency of every live query subscription.** When it changes, the query runtime re-runs all active `useQuery` subscriptions. Because ALL reads flow through query handlers (04 §7 — screens never touch `ProjectionDb`), re-execution IS the privileged-data invalidation: newly forbidden rows/fields drop from every screen (PRD-011 §7 "a report open on screen must re-check on its next fetch"); newly denied queries surface the denial state and terminate (§7).
4. **Module-declared caches.** Any cache holding query results outside the query runtime (v0 has none; media thumbnails are governed by 06-media-pipeline) MUST register an invalidation hook on permission-set change, keyed by the permission ids it depends on. Building such a cache without the hook is forbidden.
5. **Grow vs shrink:** both trigger the same recompute + re-run; there is no "grant fast, revoke slow" asymmetry.

## 9. Data-level gating

Permissions gate **data, not merely actions** (FR-1029): a field the user may not see is **never sent to the client** by a query — not sent-and-hidden.

Rules (normative):

1. Gating happens **in the query handler**, on both runtimes, never in the UI (04 §6, FR-1029). The handler consults `qctx.hasPermission(...)` and shapes the row.
2. A gated field is **absent** from the row object — never `null`, never masked (`"***"`). Absence is the contract; `null` would be indistinguishable from real data. Row-level gating filters rows out entirely.
3. Every gated field/row-class maps to a registry permission, named in the owning module's spec, and ships an **adversarial test asserting absence** for an unauthorized caller BEFORE review (CLAUDE.md §2.5). The shared module-contract test suite includes a fixture module with one gated field to keep the mechanism itself under test.
4. v0 registry has **one** gating case: rows of `auth_permission_denials` with `scopeStoreId = null` (tenant-scope denials, e.g. denied role-management attempts) are returned only when the caller holds `auth.audit_view` via a **tenant-wide** grant; store-scoped holders see only their store's rows. The `notes` module has no gated fields.
5. When server-exposed queries exist (v1 reporting API), the same handlers run server-side and "never sent" holds literally at the wire.

**Shared-device honesty (do not oversell):** sync pull is *device*-scoped (api/01-sync §4.1) — the local op log on a shared device contains payloads for the whole store, regardless of which user is active. Query-layer gating protects every legitimate read surface (UI, future agent, future API); it does not protect against forensic extraction from the device database. At-rest protection is SQLCipher (op-sqlite 17.1.2, `sqlcipher: true`) with the key in expo-secure-store — which is encrypted-at-rest storage, **not** a non-extractable-key enclave; a rooted device with the app's keys is a breach, per PRD-011 §8. True "never on this device" for high-sensitivity fields (e.g. v1 `inventory.view_cost_price`) requires **per-role/per-user sync scope** — deferred with OQ-1103, see roadmap.md. Any v1 module introducing a field whose exposure to co-workers on a shared device is unacceptable MUST raise that dependency, not rely on this section alone.

## 10. v0 default roles

v0 ships exactly three system-default roles (`isSystemDefault: true`, editable per FR-1024, seeded at tenant provisioning by the server-side flow owned in `api/02-auth.md` §2; grant lists owned here):

| Role (roleKey) | `scopeType` | Purpose |
| -------------- | ----------- | ------- |
| `main_owner` | `tenant` | Franchise owner. Holds every v0 permission via a tenant-wide grant. The seed user's role. |
| `store_owner` | `store` | Per-store administrator: manages that store's users, devices, notes. Multi-store owners get one grant per store. |
| `staff` | `store` | Baseline worker: works with notes, administers nothing. |

**Why only three (and not the FR-1024 repair-shop set):** v0 has no business modules, so manager/cashier/technician/purchaser/driver/accountant would be empty names differing only on permissions that do not exist yet — seeding them now hardcodes guesses the v1 brainstorm will overturn. Three roles cover every authorization semantic v0 must prove: a tenant-wide grant (`main_owner`), a store-scoped grant incl. multi-store via multiple grants (`store_owner`), and a low-privilege principal that exercises denial paths and the union rule (`staff`). The full default set ships with the v1 modules that give its permissions meaning — roadmap.md. Role names are English internal roleKeys (`main_owner | store_owner | staff`), displayed via label catalog keys `role.<roleKey>.name` (07-i18n §3.1 reserves the `role` namespace).

## 11. v0 permission registry (complete)

This table is the registry. An id not listed here does not exist in v0.

### 11.1 `auth` module

| id | scope | isDangerous | Description (canonical EN) |
| -- | ----- | ----------- | -------------------------- |
| `auth.user_create` | store | no | Can create employee accounts for the store. |
| `auth.user_edit` | store | no | Can edit an employee's name, photo, and store membership. |
| `auth.user_deactivate` | store | **yes** | Can deactivate an employee's account, removing their access everywhere. Their history is kept. |
| `auth.user_reset_pin` | store | **yes** | Can reset another employee's PIN. Whoever holds this can take over that person's identity until they change it. Resetting the PIN of a `main_owner` role holder additionally requires the actor to hold `main_owner` (api/02-auth §6.6; server push-validated, 05 §9). |
| `auth.pin_change` | store | no | Can change their own PIN. |
| `auth.pin_unlock` | store | no | Can clear an employee's PIN lockout so they can try again. |
| `auth.role_manage` | tenant | **yes** | Can create, rename, edit, and delete roles, and give them to employees or take them away — deciding what each person is allowed to do across the whole business. |
| `auth.device_enroll` | store | **yes** | Can approve a new device for the store. An approved device can record and sign business actions. |
| `auth.device_revoke` | store | **yes** | Can block a device (lost, stolen, retired). Anything not yet synced from it will be rejected. |
| `auth.device_read` | store | no | Can see the store's devices, who is enrolled on them, and when each last synced. |
| `auth.tenant_configure` | tenant | **yes** | Can change business-wide settings that apply to every store. |
| `auth.audit_view` | store | no | Can view the audit trail: denied attempts, PIN resets, user switches, and device events. Tenant-wide rows require a tenant-wide grant (§9.4). |

### 11.2 `notes` reference module

| id | scope | isDangerous | Description (canonical EN) |
| -- | ----- | ----------- | -------------------------- |
| `notes.create` | store | no | Can create a note in the store. |
| `notes.edit` | store | no | Can edit the body of an existing note. |
| `notes.archive` | store | no | Can archive a note, removing it from the store's active list. |
| `notes.read` | store | no | Can read the store's notes. |

### 11.3 `platform` module

| id | scope | isDangerous | Description (canonical EN) |
| -- | ----- | ----------- | -------------------------- |
| `platform.conflict_view` | store | no | Can see conflicts — places where two devices recorded contradictory changes to the same record. |
| `platform.conflict_acknowledge` | store | no | Can review a surfaced conflict and acknowledge it, confirming the recorded outcome. |
| `platform.set_locale` | store | no | Can change their own app language. |

## 12. Authz matrix (v0)

✓ = in the role's `permissionIds`. `main_owner`'s grants act tenant-wide (a tenant-wide grant satisfies store scope in every store, §5.2 step 4); `store_owner`/`staff` grants act only in stores they are granted.

| Permission | main_owner | store_owner | staff |
| ---------- | :--------: | :---------: | :---: |
| `auth.user_create` | ✓ | ✓ | – |
| `auth.user_edit` | ✓ | ✓ | – |
| `auth.user_deactivate` | ✓ | ✓ ¹ | – |
| `auth.user_reset_pin` | ✓ | ✓ ¹ | – |
| `auth.pin_change` | ✓ | ✓ | ✓ |
| `auth.pin_unlock` | ✓ | ✓ ¹ | – |
| `auth.role_manage` | ✓ | – | – |
| `auth.device_enroll` | ✓ | ✓ | – |
| `auth.device_revoke` | ✓ | ✓ | – |
| `auth.device_read` | ✓ | ✓ | – |
| `auth.tenant_configure` | ✓ | – | – |
| `auth.audit_view` | ✓ | ✓ ² | – |
| `notes.create` | ✓ | ✓ | ✓ |
| `notes.edit` | ✓ | ✓ | ✓ |
| `notes.archive` | ✓ | ✓ | ✓ |
| `notes.read` | ✓ | ✓ | ✓ |
| `platform.conflict_view` | ✓ | ✓ | – |
| `platform.conflict_acknowledge` | ✓ | ✓ | – |
| `platform.set_locale` | ✓ | ✓ | ✓ |

¹ Store-boundary rule §5.4.3 — only users whose store memberships lie within the holder's granted stores.
² Store rows only; tenant-wide audit rows gated per §9.4.

Built-in denial paths this matrix provides for the reference harness (04 §8): `staff` attempting `platform.conflict_view` or any administrative `auth.*` permission (e.g. `auth.user_create`); plus a harness user with zero grants attempting `notes.create` (the literal 04 §8 case).

## 13. Out of v0 scope (forward references — roadmap.md)

| Item | Trigger |
| ---- | ------- |
| Full repair-shop default role set (FR-1024) | v1 module brainstorms |
| Server-side permission audit of pushed ops (flag, never reject) — beyond the §4 privileged-PIN exception | v1 hardening (§4) |
| Store switcher + multi-store active-store context (FR-1034) — v0 pins `ctx.storeId` = the device's store (§5.2) | v1 multi-store pull scope (api/01-sync §4.1) |
| Per-role/per-user sync scope for true field-level device exclusion (OQ-1103) | first v1 field where §9's shared-device caveat is unacceptable (e.g. cost price) |
| Manager-override / PIN-approval elevation (OQ-1003) | POS brainstorm |
| Support impersonation — explicit, consented, logged; never ambient (FR-1040, OQ-1005) | SaaS onboarding work |
| Cross-store aggregate views (FR-1035) | v1 reporting (needs cross-store pull, api/01-sync §4.1) |
