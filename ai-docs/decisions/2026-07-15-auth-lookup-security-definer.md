# Decision — 2026-07-15 — D14: the auth entry path crosses tenants via SECURITY DEFINER functions, not a BYPASSRLS app role

> Trigger: task 13 (auth-server) hit a foundational gap the decompose left open — and which the spec itself flagged and never closed. `10-db-schema.md` §6 and `api/02-auth.md` were noted during authoring as needing "the login resolution path stated" (a DDL-comment TODO). This resolves it.

## The gap (real, verified against the specs, not the report)

The identity control plane (D11) is tenant-isolated by Postgres RLS with **FORCE** on every tenant table, and the production role `bolusi_app` is **NOBYPASSRLS** (10-db §6, asserted in `migrations.test.ts`). Access goes through `forTenant(tenantId)`, which requires the tenant up front and sets `set_config('app.tenant_id', …, true)`.

But the auth **entry** path must read a row whose tenant is unknown until the read succeeds:

- **`verifyToken`** (every request): the opaque `bdt_`/`bcs_` token carries no tenant. Auth is **hash-then-lookup** (api/02-auth:463) — you must find the device/control-session row by `token_hash` to *learn* the tenant.
- **`POST /v1/auth/login`**: `loginIdentifier` is **globally unique across tenants** and the endpoint "takes no tenant discriminator" (api/02-auth:42). You must find the user by identifier to learn tenant + stores.

Under FORCE-RLS as `bolusi_app`, these lookups are impossible: no `set_config` → fail-closed error; wrong tenant → 0 rows. As specified, **the server literally cannot authenticate anyone.** Empirically confirmed by task 13 against the migrated schema as `bolusi_app`.

## D14 — three SECURITY DEFINER functions, owned by a privileged role; `bolusi_app` stays NOBYPASSRLS

**What:** Add exactly three read-only, key-lookup functions to the db-server schema (own migration), `SECURITY DEFINER`, owned by a role with the rights to bypass RLS (the table owner or a dedicated `bolusi_auth` owner role). `bolusi_app` is `GRANT EXECUTE` on these three and gets **no other** cross-tenant capability:

- `auth_find_device_by_token_hash(hash) → (tenant_id, store_id, device_id, status)` — no key material returned beyond what identifies the row; the token hash is the *input*.
- `auth_find_control_session_by_token_hash(hash) → (tenant_id, user_id, session_id, status, expires_at)`
- `auth_find_login_credential(identifier) → (tenant_id, user_id, password_verifier, status)` — returns the stored verifier for the app-side `timingSafeEqual` compare; the plaintext credential is never in the DB.

Each: takes a hash/identifier, returns **only the single matched row's minimal fields**, returns nothing on no-match (fail-closed). After the function resolves the tenant, the handler proceeds normally through `forTenant(tenant)` for everything else, and does the constant-time token/verifier comparison in app code.

**Why SECURITY DEFINER functions, not a BYPASSRLS application role:**
- A `bolusi_app`-with-BYPASSRLS (or a second BYPASSRLS role the app connects as) can run **arbitrary** cross-tenant queries — one forgotten `.where` and it reads every tenant. The blast radius is the whole schema.
- A SECURITY DEFINER function can do **only what its body says**: one keyed lookup returning fixed columns. The bypass surface is three auditable function bodies, not an open connection. `bolusi_app` itself keeps NOBYPASSRLS, so the RLS FORCE guarantee for all normal handlers is untouched and the SEC-TENANT sweep still holds.
- This is the standard Postgres pattern for RLS-compatible auth lookups. It confines the one unavoidable cross-tenant read to the narrowest possible surface.

**Alternatives rejected:**
- *BYPASSRLS app role* (task 13's first proposal): simplest, but the broadest bypass — rejected for blast radius above.
- *Non-RLS routing table* (`token_hash → tenant_id`, `login_identifier → tenant_id`, populated on enrollment/user-create): keeps RLS on all credential tables, but adds a second source of truth and dual-write consistency risk, and still exposes a table that must be reasoned about. SECURITY DEFINER reads the real table with no duplication. Rejected as more moving parts for no security gain (the routing table leaks the same tenant-of-a-hash fact the function does).
- *Client sends a tenant hint on login*: contradicts api/02-auth:42's "no tenant discriminator" and the global-uniqueness design; would be a spec change with worse ergonomics. Rejected.

## Who builds it, and the guardrails

**Task 13 implements it** (it has the full context and is the sole consumer; splitting into a separate db-server task serializes for no benefit — no other agent is adding a db-server migration: task 19 consumes the existing media tables and adds none). The "do not touch db-server source / no new migrations" constraint on task 13 is **relaxed for exactly this change**, with these guardrails:

1. Lands as its **own clearly-labelled commits** (`feat(db-server): auth-entry cross-tenant lookup functions`), separable in review.
2. **Doc-first** (change-control): `10-db-schema.md` §6 documents the three functions + the `bolusi_app` EXECUTE grant + that they are the *only* sanctioned cross-tenant path; `api/02-auth.md` states the login/token resolution path (closing the DDL-comment TODO). Then the migration, then the code.
3. **Adversarial tests, before review** (CLAUDE.md §2.5), each falsified (§2.11):
   - `bolusi_app` **cannot** run an arbitrary cross-tenant `SELECT` on users/devices/control_sessions (still 0 rows / error) — only the three functions cross tenants. Assert the fixture (another tenant's row EXISTS) before asserting the arbitrary read returns nothing (T-14b — the exact task-05 vacuity trap).
   - Each function returns **only** the matched row's minimal fields and **nothing** for a non-matching key (fail-closed).
   - The functions cannot be coaxed into returning other rows (no injection via the identifier/hash; parameterized).
   - `bolusi_app` retains NOBYPASSRLS (the existing `migrations.test.ts` assertion still passes) and the SEC-TENANT sweep still enumerates FORCE-RLS on every tenant table.
4. **review-02 scrutinizes this as the primary security surface** of task 13 — it is a deliberate hole in the tenant boundary, so it gets the crown-jewel treatment.

## Note for task 31

The SEC ids on task 13's file are a decompose mismatch: the **server** legs are `SEC-DEV-01/02/03/04/05/07` (device/token/enrollment/key-storage), which task 13 ships. `SEC-AUTH-*` are **client-side PIN-KDF** owned by tasks 14/09/10 — task 13 does not ship them (my launch prompt said "SEC-AUTH" in error). Task 31's audit corrects the doc.
