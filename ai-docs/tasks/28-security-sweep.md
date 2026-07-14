# TASK 28 — security-sweep (SEC inventory, cross-surface adversarial run, release gate)

**Status:** todo
**Depends on:** 13, 14, 16, 17, 19, 20, 21, 25, 26

## Goal

Final cross-surface security verification per CLAUDE.md §2.5 and the security-guide §12 roll-up, now that every surface exists. Delivers (1) an automated **SEC inventory**: parse `security-guide.md` for `SEC-[A-Z]+-[0-9]+` ids, cross-check against test titles AND actual pass results from the suite runs, and drive the task-01 pending-ID allowlist to empty; (2) the **cross-surface adversarial run** in `@bolusi/harness`: SEC-TENANT-04 (the one id explicitly deferred by tasks 05/12 — a route-table walk probing EVERY registered endpoint for cross-tenant/unassigned-store leaks with §2.2 404/403 semantics, including the documented media-download exception), an RLS coverage re-enumeration against the full final migration set on real Postgres, and a permission-registry sweep (every command/query permission id resolves against 02-permissions §11; dangerous-permission authz-matrix spot checks per §12); (3) a repo **secrets scan** and a **dependency pin/lockfile audit** against 08-stack-and-repo §2; (4) all of it wired into CI as `pnpm sec:sweep`, a release gate replacing task 01's placeholder stage. This task builds sweep machinery and tests only — any product-surface defect it finds becomes a new task file (CLAUDE.md §2.6/§2.7), never a drive-by patch here.

## Docs to read

- `security-guide.md` — **all**: §2.1 (id/title conventions, SEC-META-01 contract), §2.2 (denied-access rule table + the media 404 exception — the probe walker's expected-response oracle), §3–§9 (per-surface SEC tables — the inventory's ground truth), §10 (secrets: SEC-SECRET-01/02, `.env` rules, hashed-at-rest rules), §11 (dependency posture: exact-pin list, single-zod, never-auto-merge), §12 (roll-up — the id count the inventory must reproduce).
- `02-permissions.md` — §11 (the complete v0 registry; an id not listed does not exist), §12 (authz matrix incl. footnotes ¹ store-boundary and ² audit scope, and the built-in denial paths listed under the matrix).
- `api/00-conventions.md` — §7 (status/error-code registry — exact codes the probe legs must see: `404 NOT_FOUND` vs `403 PERMISSION_DENIED` vs `401 AUTH_TOKEN_*`/`DEVICE_REVOKED`; §7.1 no-input-echo rule the leak assertions rely on).
- `08-stack-and-repo.md` — §2 only (pin policy §2.1, authoritative tables §2.2–2.5, forbidden packages §2.6) + §5.6 row layout for where the release-gate stage lands in `ci.yml`.

## Skills

- `superpowers:test-driven-development` — the SEC tables and §2.2 rule table above ARE the test list; write probes first, watch them fail against a seeded fixture leak.
- `superpowers:verification-before-completion` — this task's whole point is evidence: paste sweep output, never claim green.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on main.

## Files / modules touched

- `packages/harness/src/security/` — sweep machinery: `sec-inventory.ts` (doc parser + vitest JSON-reporter cross-check), `route-walker.ts` (enumerates the Hono route table off the in-process `@bolusi/server` app — new endpoints auto-covered), tenant-probe client (device/user credential fixtures for tenants A/B, stores 1/2), permission-registry sweep over the `@bolusi/modules` manifests.
- `packages/harness/test/security/` — the suites: SEC-TENANT-04, denied-access semantics audit, RLS re-enumeration, permission sweep, dependency audit, secrets-scan assertions.
- `packages/test-support/` — SEC-META-01 pending-ID allowlist **emptied** (task-01 contract: task 28 requires it empty). Test-only, not contended.
- Root `package.json` — `sec:sweep` script (composes inventory + harness security suites + `test:rls` RLS re-run + scans); `scripts/` — dependency-audit + secrets-scan CI entry scripts alongside `check-single-zod.*`.
- `.github/workflows/ci.yml` — replace the named release-gate placeholder with the real `sec:sweep` stage.
- **Contended packages: none.** `@bolusi/core`, `@bolusi/schemas`, product routes untouched. A gap found in any surface ⇒ stop and file a task + `_index.md` row, per CLAUDE.md §2.6/§4.

## Acceptance

- **Observable done-condition:** `pnpm sec:sweep` exits 0 locally and in CI, and the CI stage is wired as a merge/release gate (placeholder gone, failure blocks). `pnpm lint` / `pnpm typecheck` stay green; pre-commit hooks pass (no `--no-verify`).
- **Inventory script green — no missing SEC id:**
  - Parses `security-guide.md` for `SEC-[A-Z]+-[0-9]+`; asserts the parsed set equals the §12 roll-up exactly (OPLOG 01–09 · SYNC 01–10 · AUTH 01–11 · DEV 01–07 · MEDIA 01–06 · TENANT 01–05 · RT 01–05 · SECRET 01–02 · META 01 = **56 ids**) — doc/roll-up drift fails the sweep.
  - Every id has ≥1 test title embedding it verbatim (security-guide §2.1.3); the `packages/test-support` pending allowlist is **empty**.
  - **Passes, not presence:** the sweep runs the owning suites (`pnpm test`, `test:server`, `test:rls`, `chaos`, harness security suites) with a JSON reporter and asserts every SEC-titled test's state is `passed`. Negative control: a fixture SEC-titled test forced to fail (or skip) makes the inventory fail — proves status is checked, not grep-existence.
- **SEC-TENANT-04 ships in THIS task** (security-guide §8.2; deferred here by tasks 05/12), title embedding the id verbatim, before review-wave (CLAUDE.md §2.5):
  - Walker enumerates **every registered route** on the composed Hono app; a route with no probe mapping **fails the sweep** (unknown ≠ skipped — future endpoints must register probes).
  - With tenant-A credentials against tenant-B resource ids → `404 NOT_FOUND` on every route; same-tenant unassigned-store scope → `403 PERMISSION_DENIED`; unauthorized list scopes → `403`, never silently-filtered `200 []`. **Any `200` — including empty-200 — fails** (security-guide §2.2).
  - **Media exception legs** (§2.2 documented exception, consistent with SEC-MEDIA-03): `GET /v1/media/:id` and the id-keyed upload routes return `404 MEDIA_NOT_FOUND` for cross-tenant, unassigned-store, other-device in-flight, and nonexistent ids — responses indistinguishable (same status, same `error.code`, no differing details beyond `requestId`).
  - Auth-less legs: every route probed without a token → `401` (WS upgrade and SSE endpoints included in the walk — re-asserting the SEC-RT-01 semantics from the sweep's vantage).
- **RLS enumeration test** (SEC-TENANT-01 mechanics re-run at final scope): against dockerized Postgres 16 with ALL landed migrations applied — every tenant table has `relrowsecurity` AND `relforcerowsecurity` true plus four-verb tenant policies; allowlist unchanged (permissions registry + migrations bookkeeping only); a fixture unprotected table makes it fail. Runs inside `pnpm sec:sweep` via the `test:rls` lane, not PGlite-only (08 §2.5 caveat).
- **Permission-registry sweep:**
  - Enumerates every command and permission-gated query across all registered module manifests (auth, notes, platform) → each referenced permission id resolves to a 02-permissions §11 registry row; an unknown id fails; a §11 id referenced nowhere is reported (warning-level, listed in sweep output).
  - **Dangerous-permission matrix spot checks** (02 §12, executed end-to-end through the command layer): `staff` denied `auth.user_create`, `auth.role_manage`, `auth.device_revoke`, and `platform.conflict_view`; `store_owner` denied `auth.role_manage` and `auth.tenant_configure`; footnote ¹ store-boundary: `store_owner` denied `auth.user_reset_pin`/`auth.pin_unlock` against a user with membership outside the holder's granted stores; privileged-target rule: `store_owner` PIN reset targeting the `main_owner` holder denied (re-asserts the SEC-AUTH-11 semantics from the sweep); zero-grant user denied `notes.create` (the literal 04 §8 case). Every denial asserts `403`/`PERMISSION_DENIED` **and** a denial operation logged (02 §7, FR-1045) — never an empty-200.
- **Secrets scan:** gitleaks (the task-01 tooling) runs over working tree AND full git history inside `sec:sweep` → zero findings outside the committed test fixture allowlist; `.env` gitignored and absent from history; `.env.example` contains names only (asserted). SEC-SECRET-01 (log-redaction over a full enroll+auth+sync run) and SEC-SECRET-02 (fixture secret caught) both green via the inventory.
- **Dependency pin/lockfile audit vs 08 §2:** script asserts (a) the security-guide §11 load-bearing set pinned exact in the pnpm catalog at exactly `kysely@0.29.3`, `hono@4.12.30`, `@hono/node-server@2.0.8`, `canonicalize@3.0.0`, `zod@4.4.3`, `@hono/zod-validator@0.8.0`, `@op-engineering/op-sqlite@17.1.2`, `react-native-quick-crypto@1.1.6`, `@noble/curves@2.2.0`, `@noble/hashes@2.2.0`, `kysely-generic-sqlite@2.0.0` — no caret/range anywhere for these; (b) exactly one `zod` version in `pnpm-lock.yaml`; (c) 08 §2.6 forbidden packages absent from the lockfile (`@hono/node-ws`, `expo-background-fetch`, `kysely-expo`, `expo-sqlite`, and `react-native-reanimated` per the v0 caution); (d) `pnpm install --frozen-lockfile` succeeds (lockfile in sync with manifests); (e) `.npmrc` `save-exact=true` present.
- **Zero cross-tenant leaks — the exit bar:** SEC-TENANT-04 walk, RLS re-enumeration, SEC-SYNC-09 (pull-scope), SEC-RT-04 (poke fan-out), and SEC-MEDIA-03 all green **in the same sweep run** — one command, one report.
- **CHAOS-\*: none belong here.** The CHAOS catalog is task 26's (correctness-under-disorder); this sweep is correctness-under-malice (security-guide §12). Both gate v0 exit (D4) — this task wires only the SEC half.
- **Lint/CI gates:** `ci.yml` release-gate stage runs `pnpm sec:sweep` at merge gate; SEC-META-01 green with empty allowlist; no new lint/boundary violations (harness imports only per 08 §3.3: `@bolusi/server` in-process test-only edge). Findings discipline verified by the reviewer: any red probe during development produced a task file + `_index.md` row, not an in-task patch to a product surface.
