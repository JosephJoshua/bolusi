# TASK 13 — auth-server (identity control plane)

**Status:** todo
**Depends on:** 05, 12

## Goal

Deliver the entire online identity control plane in `@bolusi/server`, mounted into task 12's Hono skeleton/middleware chain: `POST /v1/auth/login` (mints hashed-at-rest `bcs_` control sessions, 10-min TTL, uniform-latency 401), `POST /v1/auth/password`, the `/v1/users` surface (create, patch, deactivate/reactivate with the `LAST_ADMIN_PROTECTED` guard, `pin-verifier` door with §5.3 bounds + greatest-`asOf` merge), and the `/v1/devices` surface (`enroll` with mandatory `Idempotency-Key`, `GET /v1/devices`, `GET /v1/devices/me`, `GET /v1/devices/me/bundle` with JCS etag/`304` and per-store grants-tuple/verifier filtering, `:deviceId/revoke`), plus `PATCH /v1/tenant/settings`. It implements `verifyToken` for both bearer prefixes (`bdt_`/`bcs_`, SHA-256 hash-then-lookup against `devices`/`control_sessions`), the `X-Acting-User` middleware and directory-backed §4.5 permission checks, device-token minting (§8, `lastSeenAt` throttle), the api/00 §8.2 idempotency store with 24 h purge, and per-endpoint rate limits (api/02-auth §9). It also ships the `provision-tenant` CLI (`bolusi_provision` path): one transaction creating tenant, stores, first owner (argon2id password verifier, `pinVerifier: null`), system actor, system device (`kind='system'`) + `system_device_chain_state` row, and the three default roles via the 02-permissions seeder. Every control-plane mutation (endpoints and CLI) appends `identity_audit` rows with secret material redacted. Revocation applies the full server effects — status flip, `401 DEVICE_REVOKED` from the very next request, push-token row deletion — and exposes an on-revoke hook registry that task 20 registers socket-close into (SEC-RT-02 lands there). Out of scope: sync push/pull (16), client enrollment/PIN runtime and the genesis op (14), push-time validation of `auth.pin_*` ops (07), role-editing endpoints (02-permissions owner, not v0-listed here).

## Docs to read

- `api/02-auth.md` — §2 (provisioning CLI, one-time password, idempotency refusal), §3 (credential inventory), §4 (login, enroll incl. validation order + idempotency token exception, §4.5 auth matrix, `X-Acting-User` trust model), §5 (bundle shape/etag/filtering, §5.3 verifier bounds + merge rule, §5.4 user management + `LAST_ADMIN_PROTECTED`), §7 (revocation semantics, `GET /v1/devices` fields incl. anomaly counts, §7.3 confirm-then-wipe contract this server must answer), §8 (token/control-session lifecycle, hashing at rest, `lastSeenAt` throttle), §9 (rate limits), §10 (error codes).
- `api/00-conventions.md` — §3/§3.1 (`verifyToken` contract, token-kind table, tenant context via `forTenant` + `set_config`), §8.2 (Idempotency-Key semantics, `X-Idempotent-Replay`), §11 (429 vocabulary; interface must not assume in-memory).
- `02-permissions.md` — §11 (the only valid permission ids for §4.5 checks); §12 matrix for test fixtures.
- `10-db-schema.md` — §4 (`devices`, `device_anomalies` read side, `idempotency_keys`), §7 (identity directory DDL: `users`, `user_pin_verifiers`, `roles`, `role_permissions`, `user_roles`, `user_stores`, `identity_audit`, `control_sessions`), §3 (system-device chain-state row provisioning must create).
- `01-domain-model.md` — §3.1 (what `bolusi_provision` creates atomically) + §3.6 (system actor and system device).
- `security-guide.md` — §6 (checklists 6.1–6.3 + SEC-DEV-01..07 definitions), §10 (config module, no secrets in logs).

## Skills

- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.
- `superpowers:test-driven-development` (always).
- `superpowers:verification-before-completion` — run the suites and the CLI against a migrated DB before claiming done.
- Security surface: work through security-guide §6.1–6.3 checklists and ship the SEC-DEV tests in this task, before review (CLAUDE.md §2.5).

## Files / modules touched

- `apps/server/src/routes/auth.ts`, `apps/server/src/routes/devices.ts`, `apps/server/src/routes/users.ts`, `apps/server/src/routes/tenant.ts` — the `auth`/`devices`/`users`/`tenant` sub-routers (08-stack §3.2), typed into the task 12 `AppType` export.
- `apps/server/src/auth/verify-token.ts` (`bdt_`/`bcs_` hash-then-lookup for task 12's `bearerAuth` slot), `apps/server/src/auth/control-sessions.ts`, `apps/server/src/auth/acting-user.ts` (`X-Acting-User` middleware), `apps/server/src/auth/permissions.ts` (directory-backed §4.5 checks).
- `apps/server/src/identity/bundle.ts` (bundle build + RFC 8785 etag), `apps/server/src/identity/audit.ts` (identity_audit writer with redaction), `apps/server/src/identity/idempotency.ts` (§8.2 store + purge), `apps/server/src/identity/revocation.ts` (effects + on-revoke hook registry + push-token cleanup), `apps/server/src/identity/rate-limits.ts` (§9 values behind the store-agnostic limiter interface).
- `apps/server/src/cli/provision-tenant.ts` + `provision-tenant` script in `apps/server/package.json`.
- `packages/schemas/src/auth.ts` — **contended package** (CLAUDE.md §4): touch only if task 02 left gaps in the api/02-auth DTOs (`LoginReq/Res`, `EnrollReq/Res`, `PinVerifierSchema` with §5.3 bounds, `DeviceBundle`, user-management schemas); serialize with other schemas work.
- Tests: `apps/server/test/identity/*.test.ts`, `apps/server/test/security/sec-dev.test.ts`. Reads `@bolusi/db-server` (`forTenant`) only — no new migrations (task 05 owns DDL).

## Acceptance

Observable done-condition: `pnpm --filter @bolusi/server test` green (all suites below) against a task-05-migrated database; `pnpm --filter @bolusi/server provision-tenant` provisions a tenant end-to-end and a subsequent login + enroll + bundle fetch round-trip succeeds against the running app.

Endpoint/unit tests (concrete):

- **Login:** 200 returns `bcs_`-prefixed session + store list per §4.2 shape; wrong password, unknown identifier, and password-less user all return identical-body `401 AUTH_INVALID_CREDENTIALS`; KDF-spy asserts the dummy argon2id verifier runs for unknown identifiers (no early return / enumeration oracle). Expired or unknown session → `401 SESSION_EXPIRED`; a control session on a device-token-only route (e.g. `/v1/devices/me/bundle`) → 401; `control_sessions` stores hash only.
- **Login rate limits (§9):** 6th failure for one `loginIdentifier` within 15 min → `429 RATE_LIMITED` + `retryAfterSeconds`, identifier locked 15 min (fake clock: unlocks after); 31st request/IP/hour → 429. Limiter interface takes an injected store (api/00 §11).
- **Enroll:** §4.3 validation order proven by ordered failures: missing `Idempotency-Key` → `422 VALIDATION_FAILED`; no `auth.device_enroll` for `storeId` → 403; taken deviceId → `409 ENROLL_DEVICE_ID_TAKEN`; reused pubkey → `409 ENROLL_KEY_REUSED`; malformed pubkey (≠32 bytes decoded) → 422.
- **Idempotent enrollment replay:** same key + same body → stored response verbatim (same `deviceToken`) + `X-Idempotent-Replay: true`, no second device row; same key + different body → `409 IDEMPOTENCY_CONFLICT`, nothing executed; concurrent duplicate executes at most once; fake-clock past 24 h → record purged (adversarial assert per §4.3) and replay now fails `ENROLL_DEVICE_ID_TAKEN`.
- **Bundle:** etag = SHA-256 hex of RFC 8785 canonicalized bundle (same `canonicalize` as 05 §3); `If-None-Match` matching → `304` with empty body; any mutation that affects the bundle (user create/deactivate, verifier accept, settings change) changes the etag. **Grants-tuple filtering (multi-store leak case, §5.2):** seed a 2-store tenant, a user in both stores with a store-scoped grant in each + one tenant-wide grant; store-1 device's bundle contains only the tenant-wide and store-1 tuples — the store-2 tuple never appears; verifier minimization: only store-1 **active** users' verifiers present; deactivated user appears `status: 'deactivated'`, `pinVerifier: null`; user removed from the store disappears entirely.
- **pin-verifier door (§5.3/§5.4):** out-of-bounds params (`mKiB=1048576`, `t=1`, wrong salt/hash length) → `422 VALIDATION_FAILED`; stale `asOf` → `{ applied: false }`, stored verifier unchanged (idempotent replay of same POST too); newer `asOf` applies + flips etag; nil-device `asOf` loses to a real op position at equal timestamp; target ≠ acting user without `auth.user_reset_pin` → 403.
- **Users:** create validates `password ⇒ loginIdentifier`, globally-unique `loginIdentifier` (cross-tenant seed) → 409/422 per envelope; creator scope must cover every `storeIds` entry → 403 otherwise; deactivate/reactivate walk `active ↔ deactivated`; **last-admin 409:** deactivating the sole active holder of the tenant-administration permission → 409 with exact code `LAST_ADMIN_PROTECTED` (server endpoint check only, §5.4 — no projection guard, no Conflict record); the same deactivation succeeds once a second active admin exists.
- **`X-Acting-User`:** missing, unknown, other-tenant, or not-usable-on-this-device (§5.1) → `403 ACTING_USER_INVALID`; usable but lacking the §4.5 permission → `403 PERMISSION_DENIED`. Permission ids used in code are exactly 02-permissions §11 strings (no `devices.enroll`-style variants — assert via registry lookup).
- **Revoke:** device path and control-session path both work; self-revoke legal; repeat revoke → identical 200 body (idempotent); audit row has `revokedBy`/`revokedAt`; push-token rows for the device deleted; registered on-revoke hooks invoked (spy — the socket-close consumer arrives in task 20).
- **Tenant settings:** `PATCH /v1/tenant/settings` requires `auth.tenant_configure`; `idleLockSeconds` clamped 60–3600 (§6.4); audited; etag flips.
- **identity_audit:** every mutating endpoint + every CLI write appends a row; provisioning rows carry `actor_user_id NULL` / `cli:provision-tenant` action convention; redaction test proves verifier salt/hash and password material never appear in `before`/`after`.
- **Provisioning CLI:** single transaction creating tenant + N stores + owner (argon2id verifier via `@noble/hashes`, `pinVerifier` absent) + system actor (`is_system`) + system device (`kind='system'`, `store_id NULL`) + `system_device_chain_state` row + default roles; one-time 24-char base58 password printed exactly once, only its verifier stored; rerun with existing `--owner-login` → non-zero exit, zero writes.
- **Token lifecycle (§8):** minted token is `bdt_` + 43-char base64url; `lastSeenAt` written at most once per 5 min per device (fake clock); tokens never logged (log capture over an enroll run greps clean for the token value).

Security tests shipped in THIS task, before review (security-guide §6.5) — server legs; ids listed explicitly:

- **SEC-DEV-01** enrollment authorization: non-holder credentials → 403, no device row, no token minted; holder → 201 + audit row.
- **SEC-DEV-02** token hashed at rest: scan `devices` (and `control_sessions`) for the issued plaintext values → absent; auth succeeds via hash lookup; a stolen `token_hash` presented as a bearer does not authenticate; companion assert: the 24 h idempotency purge (above) bounds the sole plaintext-retention exception.
- **SEC-DEV-03** revocation latency semantics: revoke → the very next request with that token (bundle GET stands in for push/pull until task 16) → `401 DEVICE_REVOKED`; `devices` row keeps `signing_key_public` forever; pre-revocation directory state (enrolled-by, pubkey) still readable via `GET /v1/devices`.
- **SEC-DEV-04** (server leg) revoked-device 401 + wipe-directive answer: every identity endpoint returns `DEVICE_REVOKED` for the revoked token, and `GET /v1/devices/me` answers the §7.3 confirm-then-wipe probe with `status: 'revoked'`; the offline-continue + queued-ops client leg lands in tasks 14/16 and re-runs in 28.
- **SEC-DEV-05** (server leg) private key never reaches the server: `EnrollReq` is `.strict()` and carries only the public key; captured request logs/audit rows from an enroll run contain no private-key bytes; full outbound-interception leg is harness-owned (26/28).
- **SEC-DEV-06** is client-surface (SQLCipher at rest) — owned by tasks 04/14; no server assertion exists here; recorded so task 28's roll-up finds it there, not missing.
- **SEC-DEV-07** (surfacing leg) key-compromise containment: seed `device_anomalies` rows → `GET /v1/devices` returns correct `anomalyCount`/`lastAnomalyAt` per device; the CHAIN_BROKEN-generation leg is task 07's.

CHAOS: none run in this task (harness is task 26); this task's revocation gate and token verify are what CHAOS-05 T7 later exercises — do not duplicate it here.

Lint/CI gates: workspace typecheck + `bolusi/boundaries` import rules pass (server imports per 08-stack §3.3 only); config read through the Zod config module, no ad-hoc `process.env` (security-guide §10); all suites above wired into the existing CI test job; pre-commit hooks green (no `--no-verify`).
