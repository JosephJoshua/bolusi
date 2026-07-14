# TASK 01 — repo-scaffold (pnpm monorepo, toolchain, CI, lint rules)
**Status:** todo
**Depends on:** —

## Goal
Stand up the entire Bolusi monorepo exactly per `08-stack-and-repo`: all 13 workspaces (`apps/mobile`, `apps/server`, `packages/{core,modules,schemas,db-client,db-server,i18n,ui,test-support,harness}`, `tooling/{tsconfig,eslint}`) as compiling shells with the real dependency pins from 08 §2 in the pnpm catalog, tsconfig project references (08 §4), ESLint flat config with the four named custom rules (`bolusi/no-hardcoded-strings`, `bolusi/no-float-money`, `bolusi/no-op-table-update`, `bolusi/boundaries` incl. the forTenant-only / no-raw-db-handle import lock) as stubs-or-real, Prettier, Vitest projects, docker-compose Postgres 16 with `bolusi_dev` + `bolusi_rls_test`, kysely-ctl wiring in `@bolusi/db-server`, EAS profiles `development`/`preview`/`test`/`production` (08 §5.5), and the CI pipeline skeleton (install+frozen-lockfile+single-zod check, lint, typecheck, unit, RFC-8785-vectors-on-Hermes placeholder stage, gitleaks). It also lands the 08 §7 bootstrap-time records as edits to `08-stack-and-repo.md` in the same PR (sanctioned by that doc's change-control note). No feature code: packages export nothing but placeholders; the deliverable is that every later task starts from green install/typecheck/lint/test. This task is **globally serial** (`_index.md`) — nothing else runs while it is in flight.

## Docs to read
- `08-stack-and-repo.md` — ALL sections. Especially: §1 runtime targets, §2 pin table + §2.1 version policy + §2.6 forbidden packages, §3 layout/boundaries/three locks, §4 tsconfig + AppType subpath shape, §5 toolchain (scripts, custom rules table, EAS profiles, CI stage outline), §6 dev environment + bootstrap sequence, §7 bootstrap-time records checklist.
- `00-product-overview.md` — "Build sequence" and "Stack" (orientation; v0 scope only).
- `security-guide.md` — §2.1 item 4 (SEC-META-01 ships with THIS task), §10 secrets handling (SEC-SECRET-02; `.env`/`.env.example` rules), §11 dependency posture (exact-pin list, single-zod lockfile check).

## Skills
- `superpowers:test-driven-development` — always.
- `superpowers:verification-before-completion` — run every acceptance command and read its real output before claiming done (CLAUDE.md §2.1).
- `context7-mcp` — verify current versions/docs when pinning the *bootstrap-pin* rows (vitest, pglite, better-sqlite3, eslint 9, prettier 3, ws, pg) and Expo SDK-57-aligned packages; record exact numbers, never ranges.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on main.

## Files / modules touched
Everything at the root and every workspace root — this is why the task is serial (creates the **contended** `packages/schemas` and `packages/core` shells, among all others).
- Root: `pnpm-workspace.yaml` (workspaces + full §2 catalog), `package.json` (exact `packageManager`, `engines.node ">=22 <23"`, canonical §5.1 scripts, `pnpm.overrides.zod = 4.4.3`), `tsconfig.json` (solution file, references only), `.npmrc` (`save-exact`, `engine-strict`), `.nvmrc` (`22`), `docker-compose.yml`, `vitest` root projects config, Prettier root config, pre-commit hook wiring (lint-staged: prettier + gitleaks), `.gitignore` (`.env`, `dist/`), `pnpm-lock.yaml`.
- CI: `.github/workflows/ci.yml` + `scripts/check-single-zod.*` (lockfile check).
- `tooling/tsconfig/` — `@bolusi/tsconfig`: `base.json` (platform-free, `types: []`, `lib: ["ES2022"]`), `node.json`, `react-native.json` per 08 §4.1.
- `tooling/eslint/` — `@bolusi/eslint-config` + `eslint-plugin-bolusi` with the four custom rules + RuleTester tests + lint fixtures.
- `packages/{core,modules,schemas,db-client,db-server,i18n,ui,test-support,harness}/` — `package.json` (names, `"type": "module"`, catalog refs, exports incl. `@bolusi/modules` subpath split shape), `tsconfig.json` (composite, correct base variant), placeholder `src/index.ts` + one placeholder `*.test.ts` each.
- `packages/db-server/` — kysely-ctl config (`kysely.config.ts`), empty `migrations/` + `seeds/` dirs (content is tasks 05); wired to `pnpm db:migrate` / `db:seed` / `db:codegen`.
- `packages/test-support/` — SEC-META-01 meta-test + its pending-ID allowlist; gitleaks fixture test.
- `apps/server/` — `@bolusi/server` shell, `@bolusi/server/client` types-only subpath export stub (08 §4.3), `.env.example` (`DATABASE_URL`, `PORT=3000`).
- `apps/mobile/` — Expo SDK 57 app scaffold (dev-client, `npx expo install` for all SDK-aligned deps), §2.2 native pins installed, `package.json` `"op-sqlite": { "sqlcipher": true, "performanceMode": true }` block, `eas.json` (4 profiles per §5.5), `app.config.ts` reading `EXPO_PUBLIC_API_URL`, `--noEmit` typecheck config per §4.2.
- `ai-docs/08-stack-and-repo.md` — §7 bootstrap records ONLY (explicitly required by 08 §7; no other spec edits).

## Acceptance
Observable done-condition — all of the following pass from a **clean clone**, outputs read directly (CLAUDE.md §2.1):
- `corepack enable && pnpm install --frozen-lockfile` succeeds; lockfile committed; `pnpm ls -r --depth -1` lists all 13 workspaces with `@bolusi/*` names matching 08 §3.1.
- `pnpm typecheck` (`tsc -b`) green; every `packages/*` + `apps/server` emits `dist/` (`.js` + `.d.ts`); `apps/mobile` typechecks `--noEmit`.
- `pnpm lint` green on the shells; all four custom rules registered at `error` in the flat config.
- `pnpm test` green (each workspace has ≥1 placeholder test so the vitest projects wiring is proven — no `passWithNoTests` masking).
- `pnpm db:up` (docker-compose) brings `postgres:16-alpine` to healthy; `psql` (or equivalent) shows both `bolusi_dev` and `bolusi_rls_test` exist; init script is idempotent (`db:up` twice = no error). `pnpm db:migrate` runs kysely-ctl against `bolusi_dev` and reports zero pending migrations (empty set, but the wiring executes).
- `.github/workflows/ci.yml` exists with the 08 §5.6 skeleton: install (frozen lockfile + single-zod check), lint, typecheck, unit, a named `jcs-vectors-hermes` placeholder job (documents the hermesc-vs-emulator candidate paths, links task 03; if the Hermes path was verified now, the mechanism is recorded in 08 §5.6/§7), and a gitleaks job. Merge-gate stages (rls/appliers/chaos/device) present as named no-op placeholders linking their owning tasks.
- Root scripts: `typecheck`/`lint`/`test`/`db:up`/`db:migrate`/`dev` work now; `test:server`/`test:rls`/`test:appliers`/`chaos`/`simulate`/`db:seed`/`db:codegen` exist but exit non-zero with `not implemented — see task NN` (never false-green).
- `apps/mobile/eas.json` has exactly the four §5.5 profiles with the stated settings (dev-client APK/channel `dev`; preview APK/channel `preview`; test = preview + `BOLUSI_TEST_HARNESS=1`/channel `test`; production placeholder).
- Pin conformance: every 08 §2 exact pin appears once in the catalog (kysely `0.29.3`, hono `4.12.30`, `@hono/node-server` `2.0.8`, zod `4.4.3`, `@hono/zod-validator` `0.8.0`, canonicalize `3.0.0`, `@noble/curves`+`@noble/hashes` `2.2.0`, kysely-generic-sqlite `2.0.0`, kysely-ctl `0.21.0`, kysely-codegen `0.20.0`, op-sqlite `17.1.2`, quick-crypto `1.1.6`); no `^`/`~` anywhere; §2.6 forbidden packages absent from the lockfile.
- 08 §7 records landed in `08-stack-and-repo.md` in this PR: bootstrap-pin rows pinned in the catalog, exact `packageManager` + TypeScript version recorded, op-sqlite bundled SQLite/SQLCipher versions read from the installed package's CMake/podspec and recorded, `@hono/zod-validator` 0.8.0 + zod 4.4.3 co-typecheck confirmed. Device-dependent records (quick-crypto argon2 option-name smoke test; Hermes CI path if not verifiable here) get an explicit TODO in §7 naming the owning task — never silently dropped.

Tests to add (concrete):
- RuleTester suites in `tooling/eslint`: each custom rule fires on ≥1 invalid fixture and passes ≥1 valid fixture at its implemented depth — `no-hardcoded-strings` (JSX string literal → error; label-catalog call → ok), `no-float-money` (`z.number()` without `.int()` in a schema-file fixture → error; `parseFloat` on `amount` ident → error), `no-op-table-update` (`updateTable('operations')` fixture → error; raw `DELETE FROM operations` string → error), `boundaries` (fixture importing `@op-engineering/op-sqlite` outside db-client → error; fixture importing `*/screens` outside apps/mobile → error; fixture value-importing `@bolusi/server` → error). Stub-depth rules still must load, register, and fire on their primary fixture.
- Single-zod lockfile check: unit test that the checker fails on a fixture lockfile containing zod v3+v4 and passes on the real lockfile.
- Invalid-input case: `pnpm install` under Node < 22 refused (`engine-strict` — verify once, record output in PR).
- Permission-denial cases: none — this task has no permission surface (evaluator is task 09).
- Idempotency: docker init script re-run (above); seed idempotency is task 05's.

SEC-*/CHAOS-* for THIS surface:
- **SEC-META-01** (security-guide §2.1.4 — explicitly ships with the CI setup task): vitest meta-test parses `security-guide.md` for `SEC-[A-Z]+-[0-9]+` IDs and fails if any ID has neither a verbatim-ID test title in the repo nor an entry in a committed pending-allowlist mapping ID → owning task file in `ai-docs/tasks/`; the test also fails if an allowlist entry names a task whose Status is `done`, and task 28 requires the allowlist empty. Test title embeds `SEC-META-01` verbatim.
- **SEC-SECRET-02** (security-guide §10): gitleaks (or equivalent) runs in the mandatory pre-commit hook and as a CI job; test proves a fixture secret is caught (scanner exits non-zero on a fixture file containing a fake credential). Test title embeds `SEC-SECRET-02` verbatim. `.env` gitignored; `.env.example` committed with names only.
- CHAOS-*: none — chaos scenarios belong to task 26 (`@bolusi/harness`); this task only leaves named CI placeholders for them.

Lint/CI gates satisfied or added by this task: CI stages 1–4 green on the PR itself; single-zod lockfile check enforced in stage 1; pre-commit hook (prettier via lint-staged + gitleaks) installed and never bypassed (`--no-verify` forbidden, CLAUDE.md §2.10); commits are Conventional, subject-only.
