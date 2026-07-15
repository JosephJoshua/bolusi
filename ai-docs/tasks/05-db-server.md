# TASK 05 — db-server: PG migrations, RLS, forTenant, codegen

**Status:** todo
**Depends on:** 01

## Goal

Deliver `@bolusi/db-server` end to end: kysely-ctl migrations implementing the FULL server DDL from 10-db-schema §4–§8 verbatim (tenants, tenant_op_counters, stores, devices, system_device_chain_state, permissions registry, device_anomalies, idempotency_keys, operations + append-only triggers, users, user_pin_verifiers, roles, role_permissions, user_roles, user_stores, identity_audit, control_sessions, media, media_chunks, push_tokens, conflicts, auth_sessions, pin_lockout_events, auth_permission_denials, user_prefs, notes, projection_watermarks), plus RLS ENABLE + FORCE with four-verb tenant policies per §6 on every tenant table, the `bolusi_app` / `bolusi_provision` roles with the §6.3 grant matrix, the `forTenant(tenantId)` wrapper factory as the ONLY exported query path for tenant tables (D7), and kysely-codegen 0.20.0 wiring producing the committed `db.d.ts`. Ships the SEC-TENANT adversarial RLS suite in this task, before review (CLAUDE.md §2.5), running on PGlite (fast) and real Postgres 16 (`pnpm test:rls` witness). Extends the ESLint boundary config so importing the raw db handle or `pg` outside this package fails lint. Out of scope: the push validation pipeline (task 07), any HTTP endpoint (task 12), seed content (`db:seed` — needs signed ops, later task), and the client SQLite side (task 04).

## Docs to read

- `10-db-schema.md` — §1 (toolchain pins), §2 + §2.1 (conventions, `signed_core_jcs` rationale), §3 (counter DDL + why; the transaction shape is task 07's to implement — this task only ships the tables), §4–§8 (the DDL — copy verbatim via `sql` literals), §10 (no indexes beyond this table), §11 (codegen & migration workflow), §12 (what must NOT be in Postgres)
- `08-stack-and-repo.md` — §3.2 `@bolusi/db-server` row (package contract: forTenant only export, migration-runner exception), §2.4 (kysely 0.29.3 exact / kysely-ctl 0.21.0 / kysely-codegen 0.20.0 / pg pins), §5.6 stages 8–9 (PGlite vs real-Postgres gates)
- `decisions/2026-07-14-v0-stack-pins.md` — D7 (two mandatory layers, transaction-local set_config), D9 (server pins)
- `security-guide.md` — §8 (tenant-isolation checklist + SEC-TENANT-01..05 table), §10 last bullet (app role vs migration role separation)
- `testing-guide.md` — §2.1 L3 row, §2.5 (normative RLS test mechanics — PGlite owner-bypass trap, `SET ROLE` requirement, catalog assertion)

## Skills

- `superpowers:test-driven-development` — always; write the RLS adversarial tests against a table list before the migrations exist.
- `superpowers:verification-before-completion` — run `pnpm db:migrate` / `pnpm test:rls` / codegen-diff yourself and read the output before claiming done.
- Context7 for kysely 0.29.3 / kysely-ctl 0.21.0 / kysely-codegen 0.20.0 API verification (`Migrator` imports from `'kysely/migration'`; training data drifts).
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on main.
- DB migrations serialize globally (CLAUDE.md §4) — confirm no other migration task is in flight before starting.

## Files / modules touched

- `packages/db-server/package.json`, `tsconfig.json`, kysely-ctl config — new workspace `@bolusi/db-server` (Node-only, `module: NodeNext`).
- `packages/db-server/migrations/NNNN_*.ts` — ordered migrations: roles + grants (idempotent `DO` blocks for `bolusi_app`/`bolusi_provision`), platform/directory tables (§4), operations + `forbid_mutation` triggers (§5), RLS enable/force/policies looped over the §6.2 table list **in the same migration as each table** (security-guide §8.1), identity directory (§7), media/push/projections (§8). Each exports `up`/`down`.
- `packages/db-server/src/forTenant.ts` + `src/index.ts` — `forTenant(tenantId)` factory: opens a transaction, runs `set_config('app.tenant_id', $1, true)` first, yields the tenant-bound Kysely handle. Package exports: `forTenant`, generated types, and a migration-runner entry — never the raw pool/db.
- `packages/db-server/src/generated/db.d.ts` — committed kysely-codegen output (`--camel-case`); runtime `CamelCasePlugin`.
- `packages/db-server/test/` — migration-apply, forTenant unit, SEC-TENANT suite (PGlite + real-PG variants share one suite per 08 §5.4).
- `tooling/eslint/` — extend `bolusi/boundaries`: raw-handle / `pg` imports forbidden outside `packages/db-server`; allowlist migrations + RLS test harness only (security-guide §8.1). **Shared tooling package — serialize with any in-flight task touching it.**
- CI config — populate stage 9 (`pnpm test:rls` vs dockerized postgres:16) and the codegen-diff check (stage skeleton exists from task 01).

No `@bolusi/schemas` / `@bolusi/core` changes (contended packages untouched).

## Acceptance

> **Added after task 04's review — codegen identifier contract.** These are not "confirm on arrival" niceties; nothing else catches their absence until a later task fails to compile or dies at runtime.
> - Server codegen **must** pass `--camel-case` (10-db §11.3). If the flag is omitted the server emits snake_case types, appliers can no longer be written once against both engines (04 §2), and no gate notices.
> - The runtime **must** wire `CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })` — **not** the defaults. At defaults `snakeCase('opAId') === 'op_aid'` while the DDL is `op_a_id`, so `conflicts.op_a_id`/`op_b_id` queries typecheck and then die at runtime. kysely-codegen's camelizer and CamelCasePlugin's inverse are **not** inverses at default options.
> - Ship the property-by-property guard: re-derive `snakeCase(prop)` for **every** generated property against the live catalog and fail on any column that does not exist, and pin the default-options behaviour so the option cannot be "simplified" away. Asserting the two ends agree by inspection is what let this through the first time.
> - **The flag is not sufficient; the guard is the durable half.** An exhaustive sweep of all 146 columns in 10-db (server §8 + client §9) through the real plugin found exactly two round-trip failures at defaults (`op_a_id`, `op_b_id`) and zero with the option set — so the blast radius today is bounded and fully repaired. But that sweep is exhaustive for **today's** schema only: the option does nothing for the next column someone adds. Do not read the flag as making the guard optional. The guard must also defend itself against vacuity (assert the expected table count and a >0-property count per interface, so a silently-empty parse cannot make every case pass).
> - `packages/db-server/src/camel-case.ts` is the **single shared config** for both engines (CLAUDE.md §2.8) — task 04 consumes it rather than growing a parallel one.
> - Fix the server row of 10-db §11.2 (line 13) if the stated generated-types path does not match what you ship.

- From a clean volume: `pnpm db:up && pnpm db:migrate` applies all migrations on `postgres:16-alpine` with zero errors; re-running `db:migrate` is a no-op; every migration's `down` reverts cleanly. The same migration set applies on PGlite inside the unit suite.
- `pnpm db:codegen` regenerates `src/generated/db.d.ts` with zero diff against the committed file; CI re-runs codegen and fails on diff (10-db §11.3). No hand-written table interfaces anywhere.
- forTenant unit tests: (a) issues `set_config('app.tenant_id', $1, true)` before any query in the same transaction; (b) rejects non-UUID / uppercase tenant ids (10-db §2 lowercase rule); (c) two sequential `forTenant(A)` then `forTenant(B)` calls on the same pool see only their own tenant; (d) the package's public export surface is exactly the documented set — a test imports the package and asserts no raw `db`/pool export exists.
- DDL spot-check tests (invalid input): `devices` CHECK rejects `kind='member'` with NULL `store_id` and unknown `status`; `user_roles` `UNIQUE NULLS NOT DISTINCT` rejects a duplicate NULL-store grant (PG16 witness); `operations` rejects duplicate `(tenant_id, server_seq)` and `(device_id, seq)`; `source`/enum-ish CHECKs reject unknown values.
- Append-only tests: UPDATE and DELETE on `operations` raise the `forbid_mutation` exception even as the table owner; as `bolusi_app`, UPDATE/DELETE/TRUNCATE on `operations` are denied by grants (SELECT, INSERT only) and `ALTER TABLE` is denied on every table (security-guide §10).
- **SEC-TENANT-01** (security-guide §8.2): automated enumeration over `pg_class`/`pg_policy` — every table with a `tenant_id` column (plus `tenants`, `user_pin_verifiers` via tenant_id) has `relrowsecurity = true` AND `relforcerowsecurity = true` AND tenant policies covering all four verbs; explicit allowlist for `permissions` + migrations bookkeeping only; a fixture unprotected table makes the sweep fail.
- **SEC-TENANT-02**: as `bolusi_app` with `app.tenant_id = A`: SELECT on B's rows → 0 rows; INSERT with `tenant_id = B` → error (WITH CHECK); UPDATE/DELETE targeting B's rows → 0 affected. Plus fail-closed: a transaction with NO `set_config` reads zero rows from every tenant table (unset-GUC case tested, not assumed — security-guide §8.1).
- **SEC-TENANT-03**: lint fixture importing the raw handle / `pg` outside `packages/db-server` fails `pnpm lint`; repo-wide CI grep for `set_config(.*false)` and `SET app.tenant_id` is clean.
- **SEC-TENANT-05**: two sequential transactions on the same pooled connection for tenants A then B — B sees zero A rows and `current_setting` returns B; a set_config-skipping bypass reads nothing, not everything.
- SEC-TENANT-04 is explicitly NOT here (needs the Hono route table — tasks 12/28). No CHAOS-* scenario targets this surface (catalog covers sync/oplog/media — tasks 07/15/16/18/26).
- All RLS tests run `SET ROLE bolusi_app` inside the test transaction before tenant-table access (testing-guide §2.5 — PGlite connections are owner and bypass RLS; a suite that passes without SET ROLE is vacuous and fails review). The full suite runs green on PGlite (`pnpm test:server` lane) AND real Postgres 16 (`pnpm test:rls`, CI stage 9 merge gate).
- `pnpm lint` and `pnpm typecheck` pass repo-wide with the new boundary rules at `error`; conventional commits, pre-commit hooks intact.
