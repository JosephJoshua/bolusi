# TASK 11 — module-contract (defineModule, queries layer, registration)
**Status:** in-review
**Depends on:** 08, 10

## Goal
Deliver the module contract in `@bolusi/core`: `defineModule` with full manifest validation (op-type naming, `.strict()` payloads, mandatory `reversal` doc, `schemaVersion` handling per 04 §3), module registration that wires a manifest's appliers into the projection engine (task 08), commands into the command runtime (task 10), permissions into the registry assembly (02 §3.2 startup-failure rules), and queries into a new query runtime. The query runtime implements 04 §6: `qctx` (`db` read-only, `tenantId`, `storeId`, `userId`, `hasPermission`), cursor pagination (no offsets, limit ≤ 100), the same fail-closed permission check commands use (denial = explicit `PERMISSION_DENIED` error with a denial op, never an empty result), and data-gating inside the handler. Ships a minimal fixture module (in `@bolusi/test-support`) with one gated column that proves the whole seam end-to-end: register → command → op → projection → query. No `notes` module, no screens, no server routes — those are tasks 25/12.

## Docs to read
- `04-module-contract.md` — §1 (manifest shape), §3 (operation registry: type format, `.strict()`, `reversal`, `schemaVersion`), §6 (queries: shape, pagination, permission check, gating, `qctx`); §5.1 step 2 + §5.3 only as referenced by §6 error paths.
- `02-permissions.md` — §3.2 (permissions block shape + the four assembly startup-failure rules), §9 (data-level gating rules 1–4: gate in handler, absent-not-null, adversarial absence test).
- `security-guide.md` — §2.2 only (denied-access semantics: client query handlers return typed `DomainError`, never a silently-filtered empty result).
- `testing-guide.md` — §1 (T-1..T-8, esp. T-2/T-3/T-6/T-7), §2.1 L2 row (round-trip environment: better-sqlite3 `:memory:` behind the shim, `@noble` crypto).
- `08-stack-and-repo.md` — §3.2 `@bolusi/core` + `@bolusi/test-support` rows, §3.3/§3.4 (core stays platform-free).

## Skills
- `superpowers:test-driven-development` — always.
- `superpowers:verification-before-completion` — run the actual suites before claiming done.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on main.

## Files / modules touched
- `packages/core/src/module/define-module.ts` — `defineModule` + manifest validation. **Contended: `@bolusi/core`** (serializes with tasks 02/06/08/10 per `_index.md`).
- `packages/core/src/module/registry.ts` — module registration; permission-registry assembly (02 §3.2); wiring appliers/commands/queries into the task-08/10 engines.
- `packages/core/src/query/` — query runtime: `executeQuery`, `qctx` construction, cursor codec, permission check.
- `packages/core/src/index.ts` — export `defineModule`, `registerModules`, query-runtime surface.
- `packages/core/test/` — manifest-validation fixtures, registration/assembly failures, round-trip, pagination property test, gating + denial tests.
- `packages/test-support/src/fixtures/fixture-module.ts` — minimal fixture module (1 op type, 1 command, 1 projection table, 1 query, 1 gated column, own-prefix permissions). Test-only; not contended.
- No changes to `@bolusi/schemas`, `@bolusi/modules`, `apps/*`.

## Acceptance
- **Observable:** `pnpm typecheck`, `pnpm lint`, `pnpm test` green; `@bolusi/core` exports `defineModule`, module registration, and query execution; the fixture-module round-trip suite passes on Node CI (L2 environment).
- **Manifest-validation rejection fixtures** (one behavior per test, unique seeded values — T-2/T-3; each rejects at `defineModule` with a typed error naming the offending key):
  - op type not matching `<moduleId>.<entity>_<event-past-tense>` (wrong prefix, uppercase, present-tense verb) → rejected;
  - `reversal` missing/empty → rejected (04 §3: mandatory);
  - payload schema not `.strict()` (unknown keys pass through) → rejected;
  - `schemaVersion` missing, non-integer, or < 1 → rejected;
  - a fully valid manifest is accepted and returned unchanged (no cloning surprises).
- **Registration/assembly startup failures** (02 §3.2 — failure, never a warning): duplicate permission id across two modules; command or query `permission` not resolving in the assembled registry; permission id prefix ≠ declaring module id; registering the same module id twice (idempotency = re-registration is an error, not a silent merge).
- **Round-trip integration (L2):** register the fixture module; execute its command via the task-10 runtime; assert the op is appended, the task-08 engine applies the projection, and the fixture query returns the row with `nextCursor: null`. Real core code throughout (T-7), better-sqlite3 `:memory:` Kysely per testing-guide §2.1.
- **Pagination cursor property test** (seeded, deterministic, seed printed on failure — T-6): N random rows, walk pages with random `limit` ∈ [1, 100] following `nextCursor` → union of pages equals the full result set exactly once (no dups, no omissions), in declared sort order, terminating with `nextCursor: null`. Plus: `limit > 100` → `VALIDATION_FAILED` (schema `max(100)`); malformed/tampered cursor string → typed `DomainError('VALIDATION_FAILED')`, never an unhandled throw or a silent restart from page one.
- **Query permission denial:** caller lacking the fixture query's permission → `DomainError('PERMISSION_DENIED')` — an explicit error, never `{ rows: [] }` (security-guide §2.2 / FR-1036) — and a denial op is emitted through the task-09/10 enforcement point with payload `surface: 'query'`, `target` = the query name (02 §7 payload; throttle behavior itself is owned by task 09, not retested here).
- **Column-gating adversarial test** (02 §9.3 — this IS the mandated pre-review adversarial test for this surface, CLAUDE.md §2.5): unauthorized caller's rows have the gated key **absent** (`'gated' in row === false` — not `null`, not masked); authorized caller receives it; the gate lives in the handler via `qctx.hasPermission`, proven by the same test passing with the UI layer entirely absent.
- **qctx surface:** exposes exactly `{ db, tenantId, storeId, userId, hasPermission }` (04 §6); a write attempt through `qctx.db` is impossible — proven by a runtime-guard test or a failing-typecheck fixture, implementer's choice, but proven.
- **SEC-\*/CHAOS-\* ids:** none are named for this surface (security-guide §12 roll-up has no module-contract/query family; CHAOS-01/07/08 exercise this contract but land with tasks 08/26). The gating-absence and denial-not-empty tests above are this task's adversarial floor and ship before review.
- **Lint/CI gates:** `bolusi/boundaries` — `@bolusi/core` stays platform-free (no `node:*`/RN/Expo imports; 08 §3.3–3.4) and `test-support` remains unimported by shipping source; `tsc -b` composite build clean; new suites run in CI stage 4 (`pnpm test`) with no new CI stage required. (The 02 §2 permission-prefix *lint* rule is owned by `tooling/eslint`, task 01 — this task's runtime startup checks are independent of it and required regardless.)
