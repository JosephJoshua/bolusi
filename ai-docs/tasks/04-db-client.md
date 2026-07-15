# TASK 04 — db-client (op-sqlite wrapper, Kysely dialect, SQLCipher, client migrations)
**Status:** in-review
**Depends on:** 01

## Goal
Deliver `@bolusi/db-client` (Hermes-only, the ONLY importer of `@op-engineering/op-sqlite` 17.1.2 in the repo): a module-singleton connection (`open({ name: 'bolusi.db', encryptionKey })`, pragma sequence per 10-db §9 preamble) where the SQLCipher key comes from an injected async key getter matching the `KeyStorePort` DB-key surface (structural type — do NOT edit `@bolusi/core`, it is contended and owned by other tasks); transaction / prepared-statement / `executeBatch` helpers behind one driver interface; a custom Kysely dialect built on `kysely-generic-sqlite` 2.0.0 against the wrapper's driver interface, never against op-sqlite directly (expo-sqlite stays a swap target per D6). Ship the FULL client migration set from 10-db §9.1–§9.6: `migrations`, `meta_kv`, `projection_watermarks`, `operations` (+ its 4 indexes), `sync_state` (+ singleton `id=1` insert), `media_items`, `users_directory`, `roles_directory`, `user_roles_directory`, `user_pin_verifiers`, `device_registry`, `pin_attempt_state`, `quarantined_ops`, `conflicts`, `notes`, `auth_sessions`, `pin_lockout_events`, `auth_permission_denials`, `user_prefs` — DDL verbatim from the spec, including CHECK constraints and partial indexes. Also deliver the driver-conformance suite in `@bolusi/test-support` (testing-guide §2.3): one statement set, driver handle injected by the runner, executed against a better-sqlite3 in-memory adapter in CI (SQLCipher OFF there by design) and registered for the op-sqlite adapter in L6. Client codegen per 10-db §11 step 4 with committed types and a CI diff. No sync logic, no `markSyncResult` bookkeeping mutator (task 06), no SecureStore implementation (tasks 14/24).

## Docs to read
- `ai-docs/10-db-schema.md` — §9 preamble (open sequence + pragmas) and §9.1–§9.6 (the DDL, verbatim); §10 client index rows; §11 steps 4–5 (client codegen workflow).
- `ai-docs/08-stack-and-repo.md` — §2.2 rows `@op-engineering/op-sqlite` and `kysely-generic-sqlite`; §2.3 `kysely` 0.29.3 pin; §2.5 `better-sqlite3` (test-only); §2.6 forbidden packages (`expo-sqlite`, `kysely-expo`); §3.1–§3.4 (db-client + test-support responsibilities, import boundary matrix, platform locks).
- `ai-docs/decisions/2026-07-14-v0-stack-pins.md` — D6 only.
- `ai-docs/testing-guide.md` — §2.1 (L2/L6 rows), §2.3 (driver-conformance suite — normative for this task), §2.6 (how L6 will invoke the suite).
- `ai-docs/security-guide.md` — §6.2 + §6.4 checklists (SQLCipher key lifecycle, qualified claims), §6.5 SEC-DEV-06 row, §1 rules 2–4 (ID-in-title, SEC-META greppability).

## Skills
- `superpowers:test-driven-development` (always).
- `superpowers:verification-before-completion` — run the gates, paste output, then claim done.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on main.

## Files / modules touched
- `packages/db-client/package.json`, `tsconfig.json` — Hermes-only package; deps: `@op-engineering/op-sqlite`, `kysely-generic-sqlite`, `kysely` (catalog pins); `better-sqlite3` devDependency only.
- `packages/db-client/src/driver.ts` — the one driver interface (execute, prepare/reuse, executeBatch, transaction begin/commit/rollback, close, typed error mapping).
- `packages/db-client/src/connection.ts` — singleton open/close, key injection, pragma sequence, single-open guard, typed `DbOpenError`.
- `packages/db-client/src/adapters/op-sqlite.ts` — device adapter (sole op-sqlite import site).
- `packages/db-client/src/dialect/` — kysely-generic-sqlite shim over `driver.ts`.
- `packages/db-client/src/migrations/` — embedded migration files + runner (versioned via the `migrations` table).
- `packages/db-client/src/generated/` — kysely-codegen output (committed; never hand-edited — 10-db §11.5).
- `packages/db-client/test/` — unit tests + the better-sqlite3 adapter as a test-only helper (injected into the conformance suite; never in shipping source).
- `packages/test-support/src/driver-conformance/` — the suite (drivers injected by the runner per 08 §3.3; test-support imports no DB driver). Parallel-safe vs task 03's vectors (different subtree) — do not touch `vectors/`.
- Root `pnpm-workspace.yaml` catalog + lockfile (new pins: op-sqlite 17.1.2, kysely-generic-sqlite 2.0.0, better-sqlite3 exact at implementation time) — root files; coordinate if another task has them in flight.
- `tooling/eslint` boundary config (extend `bolusi/boundaries` for the new package) + CI workflow (codegen-diff step, conformance job). Shared tooling — serialize with any in-flight task touching it.
- NOT touched: `packages/core`, `packages/schemas` (contended — no edits from this task).

## Acceptance
- **Green commands (CI, every PR):** `pnpm -F @bolusi/db-client build`, `pnpm -F @bolusi/db-client test`, conformance suite job green on the better-sqlite3 in-memory adapter.
- **Migrations apply clean:** fresh in-memory DB → runner applies all §9.1–§9.6 DDL; a test compares `sqlite_master` against the spec's full table + index list (all 19 tables, the 4 `operations` indexes incl. both partials, `idx_media_items_queue`, `idx_conflicts_surfaced`, `idx_notes_created`); `sync_state` row `id=1` exists; re-running the runner applies nothing (idempotent); a deliberately failing migration leaves no partial schema (transactional apply test); CHECK constraints proven live (e.g. `operations.source = 'bogus'`, second `sync_state` row, `seq = 0` → each rejected).
- **Codegen gate:** CI builds a scratch SQLite DB from all client migrations, runs kysely-codegen against it, and `git diff --exit-code` passes on the committed generated types (10-db §11.4).
- **Driver conformance (testing-guide §2.3, exact statement set):** types round-trip (INTEGER/REAL/TEXT/NULL/blob), transaction commit + rollback, prepared-statement reuse, batch insert, error mapping — identical results asserted; suite takes an injected driver handle and is registered/exported for the L6 runner with the op-sqlite adapter (device execution lands with task 27; here it must compile and be invocable with either adapter).
- **Open-path unit tests (fake driver):** (a) key is read via the injected getter exactly once, passed as `encryptionKey`; key bytes never appear in any log line or error message (assert on captured output); (b) pragmas applied post-open in spec order: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`; (c) **wrong-key failure case:** driver open error → typed `DbOpenError`, and the wrapper never retries without `encryptionKey` — no plaintext-fallback path (assert single open attempt, always keyed); (d) missing/empty key from the getter → throws before any driver call.
- **Single-connection invariant:** second `open()` while a connection is live → throws; `close()` then `open()` succeeds; Kysely dialect and raw helpers share the one connection (no second driver handle ever constructed — asserted via fake-driver instantiation count).
- **Dialect tests:** CRUD through Kysely against the wrapper equals raw-driver results on the same DB; transaction via Kysely rolls back on error.
- **SEC-DEV-06** (`DB at rest is ciphertext`) ships IN this task, title verbatim, before review (CLAUDE.md §2.5): CI leg = (c)+(d) above under the SEC-DEV-06-titled test; L6 leg implemented now in the conformance/L6 suite (copy DB file → open without key → not a valid SQLite database; open with wrong key → failure; byte-grep finds no seeded plaintext markers), tagged for the on-device runner and compiling in CI. No CHAOS-* scenario attaches to this surface (catalog ids belong to sync/oplog/media/PIN tasks); this task's harness obligation is §2.3, incl. the single-connection rule the harness mirrors.
- **Lint/CI gates:** `bolusi/boundaries` covers `@bolusi/db-client` exactly per 08 §3.3 (may import `core`, `schemas`, op-sqlite, `kysely-generic-sqlite` — nothing else); repo-wide rule that `@op-engineering/op-sqlite` imports outside `packages/db-client` fail lint, proven by a lint fixture; `better-sqlite3` absent from all shipping dependency lists; no `node:*` imports in db-client src; all new pins exact in the catalog, lockfile committed, CI `--frozen-lockfile` still green.

---

## Implementation record (2026-07-15) — read before review

### SQLCipher / SEC-DEV-06: what is and is NOT proven in CI
Per testing-guide §2.3, **SQLCipher is OFF in the CI lane by design**: better-sqlite3 ships no SQLCipher build and op-sqlite is a JSI native module that cannot run in Node (nor on this Linux host). No test here claims otherwise, and no fake green was manufactured to cover it.

`SEC-DEV-06 DB at rest is ciphertext` ships with the title verbatim, split exactly as this task file directs:
- **CI leg** (`packages/db-client/test/connection.test.ts`, `describe('SEC-DEV-06 DB at rest is ciphertext')`) — acceptance (c)+(d): wrong-key driver failure → typed `DbOpenError`, exactly one open attempt and always keyed (no plaintext-fallback path); missing/empty key throws before any driver call; key bytes never reach an error message, an error `cause`, or a captured log line.
- **L6 leg** (`packages/test-support/src/driver-conformance/at-rest.ts`, `checkDbAtRestIsCiphertext`) — implemented now, platform-free and fully injected (copy → open unkeyed → open wrong-key → byte-grep for the plaintext SQLite header and seeded markers). It compiles in CI and is exported for the on-device runner; **task 27 executes it against real SQLCipher.** CI additionally unit-tests the probe's *detection logic* against fakes (`at-rest.test.ts`) so the probe is proven to catch a plaintext DB rather than rubber-stamp whatever it is handed — the probe itself cannot be the thing that silently passes on device.

The `sec-pending-allowlist.json` entry for SEC-DEV-06 was removed, since the test now ships.

### Deviations / decisions a reviewer should scrutinise
1. **New inter-package edge — `test-support` → `@bolusi/db-client`, TYPE-ONLY.** 08 §3.3's `test-support` row does not list it. The suite must be typed against `DbDriver` (the ONE driver interface, CLAUDE.md §2.8 — duplicating the shape in test-support was the alternative and was rejected). No runtime edge exists: the emitted `dist/**/*.js` contains no db-client import. Per CLAUDE.md §4 the boundary table was **not** edited as an implementation side effect — **this edge needs ratifying by a spec task** (or hardening into the positive allow-matrix that `boundaries.js` defers to task 28).
2. **`@bolusi/db-client/op-sqlite` subpath export.** The op-sqlite adapter is not re-exported from the package index, because importing the index in Node would otherwise load a JSI native module and break every Node test. The device app and the L6 runner import the factory from the subpath and inject it into `openClientDb`. op-sqlite remains this package's sole import site.
3. **Client codegen runs WITHOUT `--camel-case`** — 10-db §11.4 (the client step) does not specify the flag; §11.3's `--camel-case` is the *server* step. Committed client types are therefore snake_case, matching the verbatim §9 DDL, and no `CamelCasePlugin` was wired into the client Kysely (that is a runtime decision this task is not licensed to make). **Open question for the spec owner:** 04 §2's dialect-neutral applier guarantee (one applier over client SQLite *and* server PGlite) likely needs identical column identifiers on both sides — if so, the client needs `--camel-case` + the plugin, and that should land as its own decision before task 11.
4. **`packages/db-client/tsconfig.test.json`** splits test/tooling typechecking (Node types) from `tsconfig.json` (shipping `src` only, `types: []`). This makes 08 §3.4's tsconfig lock real: a `node:*` import in db-client shipping source cannot resolve. `bolusi/boundaries` enforces the same rule a second way (`nodeInHermesSource`).
5. **`bolusi/boundaries` extended** (deny-list depth, per the rule's own header note): `better-sqlite3` gains `packages/db-client` as a **test-only** owner (test/ + scripts/ only — shipping source still errors, fixture-proven), and db-client shipping source is barred from `node:*`.
6. **New pin:** `@types/better-sqlite3 7.6.13` (exact, catalog). better-sqlite3 12.11.1 ships no types.
7. The scaffold's placeholder `packages/db-client/src/index.test.ts` was deleted — it asserted on the `PACKAGE_NAME` placeholder export that this task replaced with the real surface.

### Not in this slice (per the Goal)
No sync logic, no `markSyncResult` bookkeeping mutator (task 06), no SecureStore `KeyStorePort` implementation (tasks 14/24). `@bolusi/core` and `@bolusi/schemas` were not touched; `DbKeyStore` is a structural mirror of the `KeyStorePort` DB-key surface, so core's real port will satisfy it without an import.
