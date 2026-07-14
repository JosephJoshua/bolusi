# API 02 — Auth: Bootstrap, Enrollment, Offline PIN, Devices & Tokens

> **Owns:** the end-to-end enrollment + authentication flows: tenant/owner bootstrap, device enrollment endpoints and on-device key generation, user provisioning to devices (the device bundle + PIN-verifier distribution), offline PIN login/switch/idle-lock, the canonical PIN lockout machine (§6.5 — 03-state-machines §9 mirrors it verbatim with a pointer), PIN set/change/reset, device revocation (server effects + client wipe directive), and the device-token + control-session lifecycle. It also owns the `auth` module's operation registry entries and the KDF parameter decision record (per 08-stack-and-repo §2.2).
> **Change control:** change this doc first, then the code.
>
> Not owned here (cross-reference, never redefine): op envelope / hashing / chaining / rejection codes → `05-operation-log.md`; sync wire protocol → `api/01-sync.md`; module/command/projection contract → `04-module-contract.md`; permission constants, matrix, and data-gating semantics → `02-permissions.md`; canonical state machines → `03-state-machines.md`; transport conventions (error envelope, middleware order) → `api/00-conventions.md`; what must be *proven* about this surface (checklists + `SEC-AUTH-*`/`SEC-DEV-*` adversarial tests) → `security-guide.md` §5–6; label-catalog strings → `07-i18n.md`.

## 1. Two planes

Identity cannot be purely a projection of device-signed operations: the server must already know a device's public key to verify its ops (05 §2.2) and must already know a user exists to scope-validate their ops (05 §9). Bootstrapping that from ops alone is circular. Therefore:

| Plane | Contents | Authority | Mutation path | Offline? |
| ----- | -------- | --------- | ------------- | -------- |
| **Control plane** | tenant, store, user records + password credentials, role/permission assignments, device registration + public keys, device tokens, revocation, tenant settings | Server (Postgres, RLS per 08-stack §7.1) | Authenticated HTTPS endpoints in this doc + the provisioning CLI (§2). Every mutation appends a row to the append-only `identity_audit` table (actor, acted-on, ms-epoch timestamp, before/after JSONB) | **No — online only** |
| **Auth operations** | on-device auth events: enrollment genesis op, user switch, session end, PIN set/change/reset audit, PIN lockout, permission denials | The operation log (05) | The `auth` module registry (§6.2): three commands through the command runtime (04 §5) plus the sanctioned runtime emissions (§6.3) | **Yes** |

Consequences, stated once:

- **User creation is online-only.** An op from a user the server has never heard of fails scope validation (05 §9, fail closed). No offline user creation, ever.
- **PIN verifiers never ride the op log.** A hash in an immutable, forever-replicated log is an unrotatable secret — forbidden. `auth.pin_changed`/`auth.pin_reset` ops carry only `{ targetUserId, verifierRef }` (audit + trigger, §6.2); the verifier itself travels the control plane: computed on the performing device and applied there immediately, `POST`ed over TLS to `/v1/users/:userId/pin-verifier` on next online contact (§5.4), and distributed to every other device via bundle refresh (§5.2). PIN set/change/reset still works offline (§6.6); the merge rule is §5.3.
- Scope-validation clarification (stated normatively in 05 §9's extension list): "an enrolled user of that tenant" means **tenant membership, not `active` status** — a user deactivated while a device was offline still gets their queued legitimate ops accepted on sync (PRD-011 §7: deactivation is eventually effective). Deactivation removes them from switchers (§5.1); it never rejects their history.

## 2. v0 bootstrap — the first tenant + owner

There is no self-registration (FR-1002) and no signup endpoint. The first tenant, store(s), and main-owner user are created by a **server-side provisioning CLI** run by an operator with DB access:

```
pnpm --filter @bolusi/server provision-tenant -- \
  --tenant-name "Bolusi Papua" \
  --store-name "Toko Jayapura" [--store-name "Toko Sentani" ...] \
  --owner-name "Ocep" \
  --owner-login "ocep"
```

The command, in one Postgres transaction:

1. Creates the tenant (UUIDv7), each `--store-name` store (UUIDv7), and the main-owner user (UUIDv7) with `status: 'active'`, `storeIds` = all created stores, and the default role set seeded via the `02-permissions` seeder (main-owner role included).
2. Generates a **one-time owner password**: 24 chars, CSPRNG, base58 alphabet. Prints it to stdout exactly once. Stores only its argon2id verifier (server-side KDF via `@noble/hashes` 2.2.0 `argon2id`, same parameter profile as §5.3 — acceptable in Node's JIT'd V8 for the rare, rate-limited login path; *never* on device).
3. Creates **no PIN verifier** for the owner (`pinVerifier: null`) — the owner sets their PIN on their first device via the forced first-PIN flow (§6.6).
4. Appends `identity_audit` rows with actor `cli:provision-tenant`.

Idempotency: refuses (exit non-zero, no writes) if `--owner-login` already exists. `loginIdentifier` is **globally unique across tenants** in v0 (the login endpoint takes no tenant discriminator); tenant-slug namespacing is a SaaS-era change (roadmap.md).

The dev seed (08-stack §6) uses this same code path.

## 3. Credential inventory

Four credentials exist. Confusing them is how auth designs rot; each row is load-bearing.

| Credential | Authenticates | Held where | Strength & role |
| ---------- | ------------- | ---------- | --------------- |
| **Password** | a user → the control plane (login §4.2, revocation fallback §7.1) | server: argon2id verifier only. Never on device | Real credential. Only users who operate the control plane have one (owner roles; `password` optional per user, §5.4) |
| **PIN** (6 digits, §6.1) | a user → the switcher on an enrolled device | verifier `{salt, params, hash}` on server + in device bundles; **the PIN itself exists nowhere and never transits the network** | Weak by design (PRD-011 §8); attribution control, not a data-at-rest or server control. security-guide §5.1–5.2 owns the honest threat math |
| **Device token** | a device → the server (every API call incl. sync — api/01-sync §2) | device: SecureStore. Server: SHA-256 hash only | Opaque 256-bit bearer secret; lifecycle §8 |
| **Device signing key** (Ed25519) | every operation the device ever emits (05 §2.2) | private key: SecureStore, never leaves the device. Public key: server, at enrollment | The crown jewel (PRD-011 §8). Storage qualified per 08-stack §2.2: encrypted-at-rest, app-readable, **not** a non-extractable enclave |

SecureStore entries owned by this surface (each value < 2 KB): `bolusi.device_private_key` (32-byte Ed25519 seed, base64), `bolusi.device_token`. (`bolusi.db_encryption_key` is owned by security-guide §6.4 / `@bolusi/db-client`; it appears here only in the wipe directive §7.3.)

## 4. Device enrollment (online, one-time)

### 4.1 Flow

Actor: a user holding `auth.device_enroll` (main owner / store owner default roles — matrix in 02-permissions §12). Preconditions: device is in the **unenrolled** state (fresh install, or after local reset/wipe; the enrollment screen is unreachable otherwise) and online.

```
1. Device generates: deviceId = UUIDv7; Ed25519 keypair via quick-crypto
   generateKeyPairSync('ed25519'). Private seed → SecureStore immediately.
2. Owner enters loginIdentifier + password → POST /v1/auth/login
   → controlSession (10 min) + the owner's store list.
3. Owner picks the store + names the device → POST /v1/devices/enroll
   (Authorization: controlSession, Idempotency-Key: UUIDv7)
   body: deviceId + devicePublicKeyB64 + storeId + deviceName …
4. Server registers the device (status 'active', pubkey stored forever),
   mints the device token (§8), returns token + tenant/store config +
   device bundle (§5.2). identity_audit row appended.
5. Device persists: token → SecureStore; bundle → the client DIRECTORY tables
   (users_directory, roles_directory, user_roles_directory, user_pin_verifiers
   — 10-db-schema §9.5) BEFORE any command executes: the permission evaluator
   (02-permissions §5.2) reads exactly these tables.
6. The auth runtime appends the device's GENESIS op (seq = 1, previousHash =
   64 zeros — 05 §2.1): auth.device_enrolled, userId = the enrolling owner.
   Runtime-emitted and exempt from the permission evaluator (02-permissions
   §4; §6.3) — the one op whose validity never depends on directory state.
   First sync pushes it.
```

The private key is generated **on the device and never transmitted** (SEC-DEV-05). The public key must be globally unique — re-enrollment always means a fresh keypair and fresh `deviceId` (§7.4; security-guide §6.1).

### 4.2 `POST /v1/auth/login`

No auth header. Purpose: mint a short-lived **control session** for enrollment and for device-less control-plane access (stolen-device revocation, §7.1).

```ts
// request
const LoginReq = z.object({
  loginIdentifier: z.string().min(1).max(64),
  password: z.string().min(10).max(128),
}).strict();

// 200
type LoginRes = {
  controlSession: string;      // opaque, 32 CSPRNG bytes base64url, prefix "bcs_"
  expiresAt: number;           // ms epoch; TTL 10 min, single user, server-side store (hash only)
  tenantId: string;
  user: { id: string; name: string };
  stores: Array<{ id: string; name: string }>;   // stores in the user's storeIds
};
```

- Errors: `401 AUTH_INVALID_CREDENTIALS` (identical body and — via a dummy-verifier argon2id computation for unknown identifiers — statistically identical latency for "no such user" vs "wrong password": no user enumeration), `429 RATE_LIMITED` with `retryAfterSeconds` (§9).
- A control session authorizes only the endpoints marked `controlSession` in §4.5, evaluated against the session user's permissions (02-permissions), and is usable from any IP within its TTL. It is not a device token and cannot call sync.
- Users without a password credential get `AUTH_INVALID_CREDENTIALS` — indistinguishable from a wrong password.

### 4.3 `POST /v1/devices/enroll`

Headers: `Authorization: Bearer <controlSession>`; `Idempotency-Key: <UUIDv7>` (**required** — a missing key fails `422 VALIDATION_FAILED`; api/00-conventions §8.2 owns idempotency semantics).

```ts
const EnrollReq = z.object({
  deviceId: z.string().uuid(),            // client-generated UUIDv7
  devicePublicKeyB64: z.string(),          // exactly 32 bytes after base64 decode
  storeId: z.string().uuid(),              // must be in the session user's storeIds
  deviceName: z.string().min(1).max(64),   // human label for device management UI
  platform: z.enum(['android', 'ios']),
  appVersion: z.string().max(32),
}).strict();

// 201
type EnrollRes = {
  deviceId: string;
  deviceToken: string;         // "bdt_" + 32 CSPRNG bytes base64url — delivered here and never again (§8)
  tenant: { id: string; name: string };
  store: { id: string; name: string };
  settings: TenantSettings;    // §5.2
  bundle: DeviceBundle;        // §5.2
  bundleEtag: string;
  serverTime: number;          // ms epoch
};
```

Validation order: idempotency-replay lookup → session valid + user holds `auth.device_enroll` scoped to `storeId` → `deviceId` unused (`409 ENROLL_DEVICE_ID_TAKEN`) → pubkey well-formed and unused (`409 ENROLL_KEY_REUSED`) → register + mint + audit.

**Idempotency-Key semantics** (owned by api/00-conventions §8.2; restated here only for the token consequence): the server stores `(keyHash, sha256(body), full response)` for **24 hours**. Replay with the same key + same body returns the stored response verbatim — including the plaintext token, which is the one narrow, retention-bounded exception to "token stored only as a hash" (a client that crashed before persisting the token must be able to retry; SEC-DEV-02 scans the `devices` table, and an adversarial test must assert the idempotency record is purged after the retention window). Same key + different body → `409 IDEMPOTENCY_CONFLICT`. After the retention window, the key is forgotten; a replay then fails `ENROLL_DEVICE_ID_TAKEN` — the operator revokes and re-enrolls.

### 4.4 What enrollment does *not* do

It does not log anyone in. After enrollment the device shows the switcher (§6); the enrolling owner authenticates by PIN like everyone else (setting theirs first via §6.6 if `pinVerifier` is null).

### 4.5 Endpoint auth matrix

| Endpoint | Device token | Control session | Permission (02-permissions) |
| -------- | ------------ | --------------- | --------------------------- |
| `POST /v1/auth/login` | — | — (mints one) | none (rate-limited) |
| `POST /v1/auth/password` | ✓ (acting user = self) | ✓ | none (requires `currentPassword`) |
| `POST /v1/devices/enroll` | — | ✓ | `auth.device_enroll` (store-scoped) |
| `GET  /v1/devices/me` | ✓ | — | none |
| `GET  /v1/devices/me/bundle` | ✓ | — | none |
| `GET  /v1/devices` | ✓ + `X-Acting-User` | ✓ | `auth.device_read` |
| `POST /v1/devices/:deviceId/revoke` | ✓ + `X-Acting-User` | ✓ | `auth.device_revoke` |
| `POST /v1/users` | ✓ + `X-Acting-User` | ✓ | `auth.user_create` |
| `PATCH /v1/users/:userId` | ✓ + `X-Acting-User` | ✓ | `auth.user_edit` |
| `POST /v1/users/:userId/deactivate` / `reactivate` | ✓ + `X-Acting-User` | ✓ | `auth.user_deactivate` |
| `POST /v1/users/:userId/pin-verifier` | ✓ + `X-Acting-User` | — | none when target = acting user (own change); `auth.user_reset_pin` otherwise (§5.4) |
| `PATCH /v1/tenant/settings` | ✓ + `X-Acting-User` | ✓ | `auth.tenant_configure` |

Permission ids are the 02-permissions §11 registry's — never module-prefix variants like `devices.enroll` (02-permissions §2).

**`X-Acting-User` trust model (explicit):** control-plane calls from an enrolled device carry the acting user's id in this header. The server verifies the claimed user is *usable on that device* (§5.1) and holds the required permission; it **trusts the device to have PIN-verified them locally** — the same trust root as op attribution (05 §2.1 `userId` is device-attested). A missing/invalid header fails closed: `403 ACTING_USER_INVALID`. All middleware ordering, the error envelope, and body limits follow api/00-conventions.

## 5. User provisioning & the device bundle

### 5.1 Which users are usable on a device

A user appears in a device's bundle iff:

```
device.storeId ∈ user.storeIds
```

A user is **usable in the switcher** iff additionally `user.status = 'active'`. Deactivated users stay in the bundle with `status: 'deactivated'` and `pinVerifier: null` — the directory keeps rendering their names on historical ops, but they cannot authenticate. Nothing else. Verifier distribution follows the verifier-minimization rule (security-guide §5.2): a device holds verifiers **only** for its own store's active users, never the whole tenant's. Multi-store users (incl. the main owner, whose `storeIds` covers all stores from provisioning) appear on devices in each of their stores. `User.status` follows the canonical machine `active ↔ deactivated` (03-state-machines).

### 5.2 `GET /v1/devices/me/bundle`

Device-token auth. Supports `If-None-Match: <etag>` → `304` (no body) or `200`:

```ts
type PinVerifier = {
  algorithm: 'argon2id';
  saltB64: string;             // 16 CSPRNG bytes, base64; NEW salt on every set/change/reset
  mKiB: number;                // see §5.3 bounds
  t: number;
  p: 1;
  hashB64: string;             // 32 bytes, base64
  asOf: CanonicalRef;          // §5.3 merge rule
};

type CanonicalRef = {          // a point in canonical order (05 §4)
  timestamp: number;           // ms epoch
  deviceId: string;            // nil UUID "00000000-0000-0000-0000-000000000000" for control-plane writes
  seq: number;                 // 0 for control-plane writes
};

type TenantSettings = {
  idleLockSeconds: number;     // default 300, clamp 60..3600 (§6.4)
};

type DeviceBundle = {
  tenant: { id: string; name: string };
  store: { id: string; name: string };
  settings: TenantSettings;
  users: Array<{
    id: string;
    name: string;
    photoMediaId: string | null;      // switcher photo (PRD-011 §6.1); fetch via api/03-media.
                                      // v0 ships no photo-upload UI (roadmap.md) — switcher falls back to initials
    status: 'active' | 'deactivated'; // only 'active' users are switcher-usable (§5.1)
    grants: Array<{ roleId: string; storeId: string | null }>;
                                      // the user's UserRoleGrant tuples (02-permissions §5.1), filtered to
                                      // tenant-wide grants (storeId = null) + grants scoped to this bundle's store
    pinVerifier: PinVerifier | null;  // null ⇒ device forces first-PIN setup on first tap (§6.6);
                                      // always null for deactivated users (§5.1)
  }>;
  rolesSnapshot: RoleDef[];           // shapes owned by 02-permissions —
  permissionsSnapshot: PermissionDef[]; // this is how offline permission checks (FR-1032) get their data
};

// 200: { bundle: DeviceBundle; etag: string; serverTime: number }
```

- `etag` = SHA-256 hex of the RFC 8785 canonicalization of `bundle` (same `canonicalize` package as 05 §3).
- **Fetch cadence:** on app start (online), and one conditional check per sync loop after pull completes (api/01-sync §6 — the loop ordering belongs to that doc; this doc owns the endpoint). The conditional request makes the steady-state cost one `304`.
- **The bundle is persisted into the client directory tables** — `users_directory`, `roles_directory`, `user_roles_directory`, `user_pin_verifiers` (own store only) — per 10-db-schema §9.5. `user_roles_directory` rows are written **verbatim** from the `grants` tuples (`userId, roleId, storeId`), wholesale-replaced on each refresh — the permission evaluator (02-permissions §5.2) reads the tuples as-is. These tables are populated from the bundle (plus the §6.6 local immediate verifier write), **never from ops**; the permission evaluator (02-permissions §5.2) and the switcher read them.
- Bundle refresh is how role/permission changes take effect "on next sync" (FR-1033) and how new PIN verifiers reach every other device (§5.4, §6.6); invalidation of cached privileged data on permission shrink is 02-permissions' contract.
- A user unassigned from the store disappears from the bundle: removed from the switcher, verifier row deleted locally. A deactivated user flips to `status: 'deactivated'` with `pinVerifier: null` (§5.1): removed from the switcher, verifier deleted, name retained for history. An offline device keeps its last bundle — deactivation is eventually effective (PRD-011 §7).

### 5.3 PIN verifier: KDF parameters (the decision record) and the merge rule

**KDF:** argon2id via react-native-quick-crypto 1.1.6 native `argon2`, **async variant** (JS thread stays free). This doc is the parameter decision record (08-stack §2.2):

| Profile | mKiB | t | p | output | When |
| ------- | ---- | - | - | ------ | ---- |
| **Default** | 32768 | 3 | 1 | 32 bytes | Always, unless the floor triggers |
| **Floor** | 19456 | 2 | 1 | 32 bytes | Only if the on-device benchmark on the 2 GB Android target exceeds 300 ms at default params (benchmark output is a committed build artifact — SEC-AUTH-10) |

- Verifiers are **self-describing** (params travel in the record); verification never guesses parameters.
- **Accepted bounds, Zod-enforced everywhere a verifier enters the system** (`POST /v1/users` §5.4, `POST /v1/users/:userId/pin-verifier` §5.4 — verifiers never appear in op payloads, §6.2): `mKiB ∈ [19456, 65536]`, `t ∈ [2, 4]`, `p = 1`, salt exactly 16 bytes, hash exactly 32 bytes. Out-of-bounds → `422 VALIDATION_FAILED`. This is the DoS guard: a hostile verifier declaring `mKiB = 1048576` must never reach a verifying device — and cannot, because verifiers enter only through these server-validated doors and devices receive them only via the bundle (SEC-AUTH-01).
- A **new random salt on every set/change/reset** (SEC-AUTH-06). Comparison is constant-time (`timingSafeEqual`), client and server (SEC-AUTH-09).
- Pure-JS KDF on device is forbidden (08-stack §2.4; Hermes is 100x+ too slow).

**Merge rule (bundle vs local write):** a device's effective verifier for a user is the one with the **greatest `asOf`** under canonical order `(timestamp, deviceId, seq)` — comparing the bundle snapshot against the local `user_pin_verifiers` directory row written by a PIN change/reset performed on this device (§6.6). The `asOf` of a device-computed verifier is the canonical position of its emitting `auth.pin_changed`/`auth.pin_reset` op. The server applies the same rule when accepting `POST /v1/users/:userId/pin-verifier` (§5.4): a stale POST — `asOf` older than the stored verifier's — is a no-op. Control-plane-created verifiers carry the nil-device `asOf`, which any real op position beats at equal-or-later timestamp. This makes concurrent offline PIN resets converge identically on the server and on every device.

### 5.4 User management (control plane)

```ts
// POST /v1/users  →  201 { userId: string }
const CreateUserReq = z.object({
  name: z.string().min(1).max(64),
  loginIdentifier: z.string().min(1).max(64).nullable(),  // globally unique; only for control-plane-capable users
  password: z.string().min(10).max(128).nullable(),        // requires loginIdentifier; argon2id-hashed server-side
  storeIds: z.array(z.string().uuid()).min(1),
  roleIds: z.array(z.string().uuid()).min(1),               // roles owned by 02-permissions
  pinVerifier: PinVerifierSchema.nullable(),                // computed ON THE CREATING DEVICE (employee types
                                                            // their own PIN there); null ⇒ first-PIN flow §6.6.
                                                            // The plaintext PIN never reaches the server.
}).strict();

// PATCH /v1/users/:userId  →  200 { userId }
const UpdateUserReq = z.object({
  name: z.string().min(1).max(64).optional(),
  storeIds: z.array(z.string().uuid()).min(1).optional(),
  photoMediaId: z.string().uuid().nullable().optional(),   // directory field only in v0 — no upload UI (roadmap.md)
}).strict();

// POST /v1/users/:userId/deactivate   → 200 { userId, status: 'deactivated' }
// POST /v1/users/:userId/reactivate   → 200 { userId, status: 'active' }

// POST /v1/users/:userId/pin-verifier  →  200 { userId, applied: boolean }
const PutPinVerifierReq = z.object({
  verifierRef: z.string().uuid(),   // equals the verifierRef in the corresponding auth.pin_changed/auth.pin_reset op (§6.2)
  verifier: PinVerifierSchema,      // §5.3 bounds; verifier.asOf = the emitting op's canonical position
}).strict();
```

- Creator's/editor's permission scope must cover every store in `storeIds` (02-permissions).
- Deactivation preserves every op the user ever performed (FR-1004) and is blocked with `409 LAST_ADMIN_PROTECTED` if it would leave the tenant with zero active holders of the tenant-administration permission (constant owned by 02-permissions; PRD-011 §7 "the main owner deactivates themselves — block it"). This guard is a **server endpoint check only** — there is no projection-side guard and no Conflict record.
- **`POST /v1/users/:userId/pin-verifier` is the only path by which the server's authoritative verifier changes** — ops never carry verifiers (§6.2). Auth: device token + `X-Acting-User` (§4.5); the acting user must be the target user (own set/change) or hold `auth.user_reset_pin` (reset). The device that computed the verifier (§6.6) POSTs it here on next online contact; acceptance follows the §5.3 greatest-`asOf` rule (`applied: false` for stale posts — idempotent convergence). Acceptance changes the bundle etag, so every other device picks the new verifier up on its next conditional `GET /v1/devices/me/bundle`.
- All mutating endpoints in this section append `identity_audit` rows.
- `POST /v1/auth/password` `{ currentPassword, newPassword }` (self only) rotates the password verifier; audited.
- Role/permission *editing* endpoints belong to 02-permissions, not here.

## 6. Offline PIN authentication

### 6.1 PIN and verify procedure

- **PIN length: 6 digits** (OQ-1001 decided here). Rationale: the verifier bundle is necessarily on-device (FR-1010), and security-guide §5.2's own math shows a 4-digit space falls offline in under a minute while 6 digits costs hours at default params — for one extra digit of typing on a numeric pad, a >100× work-factor is the right trade. Fixed in v0 (not tenant-configurable).
- Verify: look up the user's effective verifier (§5.3) → `argon2id(pin, salt, params)` async via quick-crypto → constant-time compare. **Budget: < 300 ms** for the KDF (SEC-AUTH-10 enforces on the 2 GB target); total tap-to-in must keep FR-1013's five-second switch.
- Verifier rows live only inside the SQLCipher DB (SEC-AUTH-09). Failed and successful attempts update the local `pin_attempt_state` table (§6.5) — not the op log, except as specified in §6.5.

### 6.2 The `auth` module operation registry

`auth` is a module manifest per 04-module-contract (operations + projections + commands; no screens beyond the switcher shell). All payload schemas `.strict()`. **No op payload ever carries verifier or hash material** — a PIN hash in an immutable, forever-replicated log is an unrotatable secret; verifiers travel the control plane only (§5.4). Envelope facts (ids, seq, hashing, signing) are 05's — never restated here.

This table is the complete, authoritative auth op registry (01-domain-model §6 and 02-permissions cross-reference it; they never restate it):

| `type` | entityType / entityId | payload | storeId | emitter | reversal (mandatory, 05 §7) |
| ------ | --------------------- | ------- | ------- | ------- | --------------------------- |
| `auth.device_enrolled` | `device` / deviceId | `{ storeId, deviceName, devicePublicKeyB64 }` | device's store | runtime (genesis, seq 1 — §4.1 step 6; evaluator-exempt, 02-permissions §4) | Not reversible; device retirement is server-side revocation (§7), audited on the control plane. |
| `auth.user_switched` | `auth_session` / new session UUIDv7 | `{ previousSessionId: uuid\|null, previousUserId: uuid\|null }` | device's store | runtime (§6.3) | Session records are historical facts; a mistaken switch is corrected by the next `auth.user_switched`. |
| `auth.session_ended` | `auth_session` / ended session id | `{ reason: 'switch' \| 'idle_lock' \| 'manual_lock' }` | device's store | runtime (§6.3) | Historical fact; not reversible. |
| `auth.pin_changed` | `user_credential` / target userId (self) | `{ targetUserId: uuid, verifierRef: uuid }` | device's store | command `auth.changePin` | Superseded by a later `auth.pin_changed`/`auth.pin_reset` on the same entityId (canonical-order LWW audit trail). |
| `auth.pin_reset` | `user_credential` / target userId | `{ targetUserId: uuid, verifierRef: uuid }` | device's store | command `auth.resetPin` (by owner; offline-capable) | Superseded by a later `auth.pin_changed`/`auth.pin_reset` on the same entityId. |
| `auth.pin_locked_out` | `user_credential` / target userId | `{ consecutiveFailures: int, windowStartedAt: int }` | device's store | runtime (10th failure — §6.5) | Cleared by `auth.pin_lockout_cleared` or any later `auth.pin_reset` on the same entityId. |
| `auth.pin_lockout_cleared` | `user_credential` / target userId | `{}` | device's store | command `auth.clearPinLockout` | Historical fact; a re-lock is a new `auth.pin_locked_out`. |
| `auth.permission_denied` | `permission_denial` / fresh UUIDv7 per denial | `{ permissionId, surface, target, reason, scopeStoreId, suppressedRepeats }` — shape owned by 02-permissions §7 | device's store | runtime (the permission evaluator — 02-permissions §7) | Historical fact; not reversible. |

`verifierRef` is a UUIDv7 minted by the performing device naming the new verifier record. It carries **no key material**; it equals the `verifierRef` the device later POSTs to `/v1/users/:userId/pin-verifier` (§5.4), tying the audit op to the control-plane distribution.

All auth ops are **store-scoped** (`storeId` = emitting device's store) — pull scope (api/01-sync §4.1) then delivers them to same-store devices only. New-verifier propagation to every other device — same store or not — rides the bundle (§5.2, §5.4); ops never carry verifiers.

**Projections** (dialect-neutral appliers, 04 §2/§4):

| Table | Fed by | Shape |
| ----- | ------ | ----- |
| `auth_sessions` | `user_switched` (insert), `session_ended` (set `endedAt`, `endReason` on its own entityId) | `id, userId, deviceId, storeId, startedAt, endedAt, endReason` — the PRD-011 §5 UserSession record |
| `pin_lockout_events` | `pin_locked_out`, `pin_lockout_cleared` | append-only audit rows keyed by `userId` (op id PK; deviceId from envelope) — owner-visible brute-force evidence |
| `auth_permission_denials` | `permission_denied` | shape, throttle, and `listPermissionDenials` query owned by 02-permissions §7 |

`user_pin_verifiers` is **not** a projection: it is a client directory table (10-db-schema §9.5) populated from the bundle plus the §6.6 local immediate write — never from ops. The **server** runs the same appliers (04 §2) for the projection tables above; the server's authoritative verifier is not among them — it changes only via `POST /v1/users/:userId/pin-verifier` (§5.4), which then flows into every affected bundle.

### 6.3 Commands, emission paths, attribution

| Command | Permission (02-permissions §11) | Executed as | Emits |
| ------- | ------------------------------- | ----------- | ----- |
| `auth.changePin` | `auth.pin_change` (every role) | self; the auth runtime verifies the **current PIN locally** before executing (skipped only when no verifier exists — first-PIN flow §6.6) | `auth.pin_changed` |
| `auth.resetPin` | `auth.user_reset_pin` (owner roles; `isDangerous` — §6.6) | the resetting owner | `auth.pin_reset` |
| `auth.clearPinLockout` | `auth.pin_unlock` (owner roles) | the unlocking owner, on the locked device | `auth.pin_lockout_cleared` |

**Runtime emissions — the sanctioned exceptions to "commands are the only write path" (04 §5's named clause; permission-evaluator exemptions listed in 02-permissions §4):** the auth runtime appends these ops directly, and nothing else may bypass the command layer (lint-enforced):

- `auth.device_enrolled` — at enrollment completion (§4.1 step 6), `userId` = the enrolling owner. Genesis op, seq 1; evaluator-exempt.
- `auth.session_ended` (`reason: 'switch'`, if a session was open) + `auth.user_switched` — after the **incoming** user's local PIN verify, in that order. Envelope `userId` on both = the incoming user: *B's switch is what ended A's session*; the payload carries the ended session/user. Switching carries no permission — authentication precedes authorization (FR-1014); every switcher-usable user (§5.1) may switch in.
- `auth.session_ended` (`reason: 'idle_lock' \| 'manual_lock'`) — when the idle timer fires (`source: 'system'`) or the user locks manually (`source: 'ui'`); `userId` = the current user.
- `auth.pin_locked_out` — at the moment of the 10th consecutive failure (§6.5) there is *no authenticated user to execute a command as*; `userId` = the targeted user, `source: 'system'`.
- `auth.permission_denied` — appended by the permission evaluator on denial (02-permissions §7 — a denial log must not itself be deniable).

Every runtime-emitted op is envelope-complete and registry-validated like any other.

**Server-side validation of privileged auth ops (push-time):** a tampered client can emit any op its device key signs; command-layer permission checks are client-side. As the **named v0 exception** to "the server does not re-verify authorization on pushed ops" (02-permissions §4), specified in 05 §9's extension list, the server validates these three op types during push processing (after schema, before acceptance) against the **directory** — the actor's roles per bundle-truth at `receivedAt`:

- `auth.pin_changed`: envelope `userId` == `entityId` (self only);
- `auth.pin_reset`: envelope `userId` held `auth.user_reset_pin`; additionally, if the target holds the `main_owner` role, the actor must also hold `main_owner` (§6.6);
- `auth.pin_lockout_cleared`: envelope `userId` held `auth.pin_unlock`.

(`auth.device_enrolled` is additionally checked structurally — seq 1 of its device, matching the registration record — per 05 §9.)

Failing ops are rejected with `SCOPE_VIOLATION` (05 §8 — the closed set gains no new code for this). Without this check, any device holder could forge a `pin_reset` against an owner and inherit owner attribution on every store device — the exact privilege escalation the fraud model exists to prevent. The general server-side permission audit of pushed ops remains v1 (roadmap.md).

### 6.4 Idle lock

- Default **300 s**, tenant-configurable via `PATCH /v1/tenant/settings { idleLockSeconds }`, clamped 60–3600 (OQ-1002 decided). Delivered in the bundle.
- On expiry: the auth runtime appends `auth.session_ended` (`reason: 'idle_lock'`, `source: 'system'` — §6.3), the UI returns to the switcher. **In-progress work survives** (PRD-011 §6.2): per-user draft/navigation state is retained in memory keyed by `userId` and restored on that user's next unlock; only the active-identity context is cleared. A lock that loses work gets disabled by whoever can disable it — preserving state is a security control (SEC-AUTH-08).
- Manual lock (switcher button) is the same runtime emission with `reason: 'manual_lock'` (`source: 'ui'`).

### 6.5 Rate limiting & lockout

**This section is the canonical PIN lockout machine** — schedule, threshold, states, and recovery are owned here; 03-state-machines §9 mirrors it verbatim with a pointer, and security-guide §5.3 and the harness (CHAOS-11) import these constants.

Enforced **per (userId, deviceId)**, entirely locally (offline is the normal case). State persists in the SQLCipher DB (`pin_attempt_state`: `userId, deviceId, consecutiveFailures, windowStartedAt, notBefore` — 10-db-schema §9.5), surviving app restart (SEC-AUTH-03). Other users on a shared terminal are never blocked by one user's failures.

| Consecutive failures | Next attempt allowed after |
| -------------------- | -------------------------- |
| 1–3 | immediately (attempts 1–3 are free) |
| 3 → 4th attempt | 30 s |
| 4 → 5th attempt | 60 s |
| 5 → 6th attempt | 120 s |
| 6–9 → each next attempt | 300 s (cap) |
| **10** | **hard lockout** — PIN auth for this user on this device is disabled; `auth.pin_locked_out` op emitted (§6.3) |

Rules:

- A successful verify resets `consecutiveFailures` to 0.
- Attempts during a delay window or lockout are **not evaluated** — the KDF is not run (SEC-AUTH-02); the refusal is free and throws `DomainError('PIN_RATE_LIMITED')` (delay) / `DomainError('PIN_LOCKED')` (lockout) per 04-module-contract §5.2; the countdown is shown via label-catalog copy.
- **Clock rollback does not shrink a window:** `notBefore` is stored as ms epoch; if `now < notBefore` the stored value stands and is never recomputed downward (SEC-AUTH-04). The hard-lock threshold is counter-based and clock-independent.
- **State machine** (`PinAuth`, per user per device — canonical here; 03-state-machines §9 is the verbatim mirror):

  ```
  unlocked → delayed        (3rd consecutive failure)
  delayed  → unlocked       (successful verify)
  delayed  → locked_out     (10th consecutive failure; emits auth.pin_locked_out)
  locked_out → unlocked     (only via the recovery paths below)
  ```

- **Recovery from `locked_out` — both paths work offline** (a days-offline store must not brick a cashier, D1/NFR-1001):
  1. **Owner unlock, same PIN kept:** a user holding `auth.pin_unlock` authenticates on the device and runs `auth.clearPinLockout` — for the case where the user knows their PIN and a colleague burned the attempts. Resets the counter to 0.
  2. **PIN reset:** `auth.resetPin` (permission `auth.user_reset_pin`, §6.6). A verifier with a newer `asOf` for a locked user — written locally by a reset performed on this device, or arriving via bundle refresh — clears that user's lockout state and counter as an auth-runtime side effect (the runtime, not a projection applier, touches `pin_attempt_state`).

  There is no online self-recovery: PIN-only users hold no server credential, so "online full re-auth" is not implementable for them; the PIN never transits the network (§3).
- Per-attempt failure records stay in the local `pin_attempt_state`/diagnostics tables; the **op log carries the lockout events** (`pin_locked_out` with the failure count, `pin_lockout_cleared`), which is the owner-visible, synced brute-force evidence (FR-1045 spirit). Per-attempt op emission is deliberately not done in v0 (log noise); revisit with v1 reporting.

### 6.6 PIN set / change / reset flows

| Flow | Trigger | Mechanics |
| ---- | ------- | --------- |
| **First PIN** | bundle row has `pinVerifier: null` (CLI-provisioned owner, or user created with null verifier) | On first switcher tap the device forces PIN setup: user enters a 6-digit PIN twice → device computes the verifier (new salt, §5.3 profile), writes it into the local `user_pin_verifiers` directory row, and `auth.changePin` executes with the current-PIN check skipped (no verifier exists at any `asOf`), emitting `auth.pin_changed` `{ targetUserId, verifierRef }`. The verifier is POSTed to `/v1/users/:userId/pin-verifier` on next online contact (§5.4). Race between two devices → greatest-`asOf` wins everywhere (§5.3). |
| **Change (self)** | user chooses "change PIN" | Auth runtime verifies current PIN locally → `auth.changePin` computes the new verifier, applies it locally at once, and emits `auth.pin_changed` `{ targetUserId, verifierRef }`; distribution per §5.4 (POST on next online contact) + §5.2 (bundle refresh to every other device). Works offline. A tampered client skipping the current-PIN check gains nothing it doesn't already have (it can only self-target — server enforces §6.3). |
| **Reset (owner)** | forgotten PIN (PRD-011 §7) | A user holding `auth.user_reset_pin` authenticates on any device of that store, opens the target user, and the *target user* types a new PIN (owner never learns it) → `auth.resetPin` computes the verifier **on the resetting device**, applies it there immediately, and emits `auth.pin_reset` `{ targetUserId, verifierRef }`. **Works offline**: the resetting device honors the new PIN at once; on next online contact it POSTs the verifier (§5.4), the server updates, and every other device — same store or not — receives it via bundle refresh (§5.2). Old PIN invalid everywhere the new verifier has reached; never recoverable (NFR-1004). Clears any lockout for the target (§6.5). The op is the audit trail. |

`auth.user_reset_pin` is `isDangerous` in the registry (02-permissions §11) because PIN = device-local identity: PIN-reset power is impersonation power — whoever can reset a PIN can *become* that user on any store device. It defaults to owner roles only (02-permissions §12 matrix), and every reset is push-validated server-side (§6.3) and audited by its own op. **Privileged-target rule:** an `auth.pin_reset` whose target holds the `main_owner` role is valid only if the acting user also holds `main_owner` — otherwise `auth.user_reset_pin` would let a store_owner impersonate the main owner. The server push-validates this rule together with the permission check (05-operation-log §9).

Residual risk, stated honestly (security-guide §5.2 owns the full math): current verifiers are on-device by design (the bundle), and a device retains a superseded verifier only until the next bundle refresh replaces it — the op log contains none, ever. The PIN's blast radius is device-local attribution only — every resulting op is still device-signed and the device is revocable.

## 7. Device revocation

### 7.1 `POST /v1/devices/:deviceId/revoke`

Auth: device token + `X-Acting-User` holding `auth.device_revoke`, **or** a control session (§4.2) — the second path is mandatory for the stolen-only-device scenario: an owner with nothing but a browser and their password can still kill a device.

```ts
// 200
type RevokeRes = { deviceId: string; status: 'revoked'; revokedAt: number };
```

Idempotent: revoking an already-revoked device returns the same body. Revoking the *calling* device is legal (owner retiring the device in hand — the response triggers §7.3 on it). `identity_audit` row: `revokedBy`, `revokedAt`.

`GET /v1/devices` (FR-1020) lists `{ deviceId, deviceName, storeId, platform, status, enrolledAt, enrolledBy, lastSyncAt, lastSeenAt, revokedAt?, revokedBy?, anomalyCount, lastAnomalyAt }` — `anomalyCount`/`lastAnomalyAt` aggregate the server's `device_anomalies` rows (`BAD_SIGNATURE | CHAIN_BROKEN | SCOPE_VIOLATION | CLOCK_SKEW`; DDL owned by 10-db-schema): the FR-829 owner-visible tamper surface. Long-unsynced devices are the UI's problem to surface (PRD-011 §6.5).

### 7.2 Server effects (immediate)

- `Device.status: active → revoked` — terminal, no un-revoke (canonical machine, 03-state-machines).
- Token auth fails from the next request: `401` with code `DEVICE_REVOKED` on every endpoint (api/01-sync §2); open realtime sockets closed (security-guide §9 / api/00-conventions).
- **Push gate is `receivedAt`-based:** every op received after revocation is rejected `DEVICE_REVOKED` (05 §8) regardless of claimed `timestamp` — the server cannot verify when an op was signed, only when it arrived. Consequence accepted and documented to owners: a stolen device's unsynced ops are lost (PRD-011 §7).
- **Everything accepted before revocation stays valid forever** (FR-1019): the public key is retained permanently and continues to verify history; revoked devices remain in the pull `devices` sidecar with their status (normative sidecar spec: api/01-sync §4), so other devices can keep verifying pulled history signed by them.
- Effectiveness is *next contact*, not instant: an offline revoked device keeps working locally until it reconnects. Software cannot reach a device that never connects; repossession is a physical control. UI copy must say this plainly (PRD-011 §7; security-guide §6.3).

### 7.3 Client wipe directive

On receiving `DEVICE_REVOKED` from any endpoint, the client: (1) shows a blocking "device revoked" screen (label catalog keys `auth.revoked.title` / `auth.revoked.body` — ui-labels via 07-i18n), (2) **confirms** by calling `GET /v1/devices/me` once — only a second `DEVICE_REVOKED`/`status: 'revoked'` answer triggers the wipe (a single spurious 401 must never wipe a fleet), then executes, in this order:

1. Delete SecureStore keys: `bolusi.db_encryption_key` **first** (crypto-erase — the DB is unreadable ciphertext from this moment even if later steps are interrupted), then `bolusi.device_private_key`, `bolusi.device_token`.
2. Delete the SQLite DB file(s) + WAL/SHM.
3. Delete media document directories (06-media-pipeline owns the paths).
4. Clear remaining app storage; reset to the unenrolled enrollment screen.

Unsynced ops and media are destroyed with the rest — by design; the mitigation for that loss is sync frequency (api/01-sync §5), not wipe reluctance.

### 7.4 Re-enrollment

A wiped (or factory-reset) device may enroll again via §4 as a **new device**: new `deviceId`, new keypair, new token, new chain starting at seq 1 (05 §4). A device identity is never resurrected (security-guide §6.1); the old chain simply ends. Key rotation in v0 **is** revoke + re-enroll — there is no in-place rotation (recorded against Q4; in-place rotation is a roadmap.md item).

## 8. Token & session lifecycle

**Decision: device tokens are long-lived and non-expiring.** No TTL, no refresh flow, no scheduled rotation. Revocable server-side at any moment (§7); rotated only by re-enrollment.

Why this is right for this system, not a shortcut:

1. **Offline-first forbids expiry.** A store can be dark for days (D1); a token that expired meanwhile would strand a queue of legitimate ops behind an interactive re-auth that a PIN-only cashier cannot perform. Expiry would convert "offline too long" into data loss or workarounds.
2. **Expiry adds no security here.** The device also holds the Ed25519 signing key — the actual crown jewel — with the same at-rest protection (§3). An attacker who can read the token can read the signing key; rotating the weaker credential on a timer while the stronger one persists is theater. The real compromise response is revocation: one kill switch that severs both (§7.2).
3. **The token authenticates the device only.** Humans are attributed per-op by the signed envelope, and PIN-authenticated locally; there is no human session server-side to expire.

Mechanics:

- Format: `bdt_` + base64url(32 CSPRNG bytes) — prefixed for secret-scanner friendliness. Minted only at enrollment, delivered only in the `EnrollRes` (§4.3 idempotency window is the sole re-delivery).
- At rest server-side: **SHA-256 hash only**, unique-indexed; auth is hash-then-lookup (`bearerAuth`'s `verifyToken`, api/00-conventions middleware order). A DB dump yields no usable tokens (SEC-DEV-02). Rows carry `deviceId`; check `status = 'active'` on every request.
- `lastSeenAt` is updated at most once per 5 minutes per device (throttled write — no hot row); `lastSyncAt` is owned by sync acceptance (api/01-sync).
- Never logged, never in URLs; header only.

**Control sessions** (§4.2) are the opposite by design: 10-minute TTL, hash-stored, bound to one user, valid only for §4.5's control-plane column — they exist so enrollment and emergency revocation need no enrolled device, and expire before they become ambient authority.

## 9. Server rate limits (this surface)

api/00-conventions §11 owns the rate-limit vocabulary — the platform default, the `429` envelope, and the single 429 code `RATE_LIMITED` (+ `retryAfterSeconds`) — and delegates per-endpoint numbers to the owning endpoint doc. These are this surface's per-endpoint values. Limits are per-tenant-fair, memory-backed in v0 (single server; distributed limiter is a SaaS-era concern).

| Endpoint | Limit |
| -------- | ----- |
| `POST /v1/auth/login` | 5 failures per `loginIdentifier` per 15 min → identifier locked 15 min; plus 30 requests/IP/hour |
| `POST /v1/devices/enroll` | 20/tenant/day |
| `POST /v1/users` (+ `PATCH`, status changes, `pin-verifier`) | 100/tenant/day |
| `POST /v1/devices/:id/revoke` | 20/tenant/hour |
| `GET /v1/devices/me/bundle` | 120/device/hour (steady state is `304`s) |
| `POST /v1/auth/password` | 5/user/day |

## 10. Error codes (this surface)

Envelope shape per api/00-conventions; codes are machine strings, user copy via 07-i18n. Op rejection codes are 05 §8's — never duplicated here.

| HTTP | Code | Meaning |
| ---- | ---- | ------- |
| 401 | `AUTH_INVALID_CREDENTIALS` | Bad login/password (uniform for unknown identifier) |
| 401 | `SESSION_EXPIRED` | Control session TTL elapsed / unknown |
| 401 | `DEVICE_REVOKED` | Token of a revoked device — triggers §7.3 confirm-then-wipe |
| 403 | `PERMISSION_DENIED` | Authenticated actor lacks the §4.5 permission (denial logged, FR-1045) |
| 403 | `ACTING_USER_INVALID` | `X-Acting-User` missing, not usable on this device (§5.1), or not in tenant |
| 409 | `ENROLL_DEVICE_ID_TAKEN` / `ENROLL_KEY_REUSED` | deviceId / public key already registered |
| 409 | `IDEMPOTENCY_CONFLICT` | Same Idempotency-Key, different body (code owned by api/00-conventions §8.2) |
| 409 | `LAST_ADMIN_PROTECTED` | Deactivation would strand the tenant with no admin (§5.4 — server endpoint check only) |
| 422 | `VALIDATION_FAILED` | Zod failure (incl. §5.3 verifier bounds and a missing `Idempotency-Key` — api/00-conventions §8.2) |
| 429 | `RATE_LIMITED` | §9 per-endpoint limits, with `retryAfterSeconds` (code owned by api/00-conventions §7) |

## 11. Out of v0 (forward references — build nothing here)

roadmap.md owns scheduling; listed to stop drift: manager PIN-override on another user's screen (OQ-1003 — attribution rules per PRD-011); per-attempt PIN-failure ops and owner-facing denial-analytics UI (the data lands in `auth_permission_denials` from day one, §6.2); general server-side permission audit of pushed ops (beyond §6.3's pin-op exception); online PIN re-auth (needs a PAKE, not PIN-over-TLS); biometric unlock (`requireAuthentication` — defense-in-depth only, security-guide §6.2); in-place signing-key + token rotation; store CRUD endpoints beyond provisioning; tenant-slug-namespaced logins; support impersonation (OQ-1005 — explicit, consented, logged if it ever exists); distributed rate limiting; user photo upload UI (`photoMediaId` ships in the directory from day one, §5.2 — the switcher falls back to initials).
