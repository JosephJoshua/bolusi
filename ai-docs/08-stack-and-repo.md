# 08 — Stack & Repo

> **Owns:** the authoritative dependency pin table, runtime targets, monorepo layout, package/import boundary rules, TypeScript configuration, toolchain (pnpm / ESLint / Prettier / Vitest / EAS / CI), and the local dev environment. This doc + `04-module-contract.md` are what `decompose-tasks` slices against. Envelope/serialization facts live in `05-operation-log.md`; sync wire protocol in `api/01-sync.md`; transport conventions (middleware order, gzip request handling, errors) in `api/00-conventions.md`; i18n mechanism in `07-i18n`; key lifecycle in the security checklist.
> **Change control:** change this doc first, then the code. A version bump, a new dependency, or a new workspace is a spec change — it lands here before any `package.json` edit.

## 1. Runtime targets

| Target | Pin | Notes |
| ------ | --- | ----- |
| Server runtime | **Node 22 LTS** | Hard floor: kysely 0.29.3 `engines >= 22`. Pinned via `.nvmrc` (`22`) + `engines.node: ">=22 <23"` + `engine-strict=true` in `.npmrc`. |
| Mobile runtime | **Expo SDK 57** (React Native 0.86, React 19.2, Hermes) | Android-first; constraint device class = 2 GB RAM Android. |
| Build channel | **EAS development builds — mandatory** | Expo Go is forbidden for this project: it cannot run push (Android), background services, SQLCipher builds, or react-native-quick-crypto (Nitro/new-arch). Every developer runs a dev-client build from day one. |
| Database (server) | PostgreSQL 16 (`postgres:16-alpine` in compose) | RLS is load-bearing (§7.1, D3/Q2). |
| Database (client) | SQLite via op-sqlite, SQLCipher build | Single connection, WAL (§2.2 caveats). |
| Package manager | **pnpm 10** (workspaces + catalogs) | Exact patch recorded in root `packageManager` field at bootstrap; Corepack-activated. **Recorded at bootstrap: `pnpm@10.34.5`** (pnpm 11.x existed; the 10-line pin here governs). |
| TypeScript | latest stable 5.x at bootstrap, single hoisted version | Floor **5.4** (kysely 0.29.x minimum). One version for the whole repo. **Recorded at bootstrap: `typescript@5.9.3`** (6.x/7.x existed; latest of the 5.x policy line taken). |

## 2. Dependency pins — the authoritative table

### 2.1 Version policy

1. **Everything is pinned exact.** `save-exact=true` in `.npmrc`; shared versions live once in the **pnpm catalog** (`pnpm-workspace.yaml` `catalog:` block) and packages reference `"catalog:"`. The lockfile is committed and CI installs `--frozen-lockfile`.
2. **kysely is `0.29.3` exact, never caret, never auto-bumped.** 0.x minors are breaking (0.29.0 itself moved `Migrator` to the `kysely/migration` subpath and raised the TS floor). Any bump is its own task with release-note review.
3. **Expo-ecosystem packages are installed only via `npx expo install`** so they stay SDK-57-aligned. An Expo SDK bump is a project-level task (it drags expo-* versions and forces an op-sqlite RN-compat re-check).
4. **`@hono/node-server` 2.x is ~3 months old** — pin exact, read the changelog before any bump (2.0.6–2.0.8 already fixed header-preservation regressions).
5. Rows marked *bootstrap-pin* were not version-verified by research: pin the current stable exactly at repo bootstrap and record the number in the catalog; never leave a range.
6. **One zod.** Root `pnpm.overrides` pins `zod` to 4.4.3 so no transitive zod v3 can coexist (`@hono/zod-validator` 0.8.0 types break against v3). CI fails if the lockfile contains two zod versions.

### 2.2 Mobile native + Expo (installed in `apps/mobile`)

| Package | Version | Why | Caveat / swap target |
| ------- | ------- | --- | -------------------- |
| `expo` | 57.0.4 (SDK 57) | Current stable; RN 0.86 + React 19.2 | SDK 57 is fresh (July 2026); third-party libs may lag — check compat before adding any native dep. |
| `@op-engineering/op-sqlite` | **17.1.2** | Fastest RN SQLite; `executeBatch`/prepared statements/`executeRaw` fit the append-only op log + projection rebuilds on 2 GB devices; `encryptionKey` is a first-class `open()` param | **Exactly ONE open connection per DB app-wide** (documented op-sqlite rule) — concurrency comes from WAL, never a second connection. Single-maintainer project: all access goes through the `@bolusi/db-client` wrapper so **expo-sqlite stays a swap target** (if swapped: `withExclusiveTransactionAsync` is mandatory — the plain variant is not isolated). Config via `package.json` block, no config plugin: `"op-sqlite": { "sqlcipher": true, "performanceMode": true }`. SQLCipher replaces vanilla SQLite — watch iOS duplicate-symbol conflicts if another dep links SQLite. Verify bundled SQLite/SQLCipher versions in the repo's CMake/podspec at bootstrap. **Bootstrap record (17.1.2): bundled SQLite `3.51.3` (`cpp/sqlite3.h` + `cpp/sqlcipher/sqlite3.h`), SQLCipher `4.14.0` (`CIPHER_VERSION_NUMBER`, `cpp/sqlcipher/sqlite3.c`).** |
| `react-native-quick-crypto` | **1.1.6** | The **only on-device crypto provider**: Ed25519 keygen/sign/verify, sync SHA-256, argon2id. Pure-JS crypto on Hermes is 100x+ too slow for hot paths (no JIT) | Requires **New Architecture + Nitro Modules + dev build** (never Expo Go). Peers below must be installed with it, plus its Expo config plugin. argon2 option names (`memoryCost`/`timeCost`/`parallelism`) mirror Node's experimental surface — smoke-test on install. |
| `react-native-nitro-modules` | ≥ 0.31.2 (peer; pin exact satisfying at bootstrap) | quick-crypto peer | — |
| `react-native-quick-base64` | ≥ 3.0.0 (peer; pin exact at bootstrap) | quick-crypto peer | — |
| `expo-secure-store` | SDK-57 aligned | Device signing key + SQLCipher key + device token storage | Values **< 2 KB** (historical iOS ceiling ~2048 bytes — design ceiling, handle native errors). It is **encrypted-at-rest storage, NOT a non-extractable-key enclave**: app code can read keys back; TEE backing is device-dependent and not guaranteed — no spec doc may claim "hardware-backed non-extractable keys". `requireAuthentication` needs a dev build. |
| `expo-camera` | SDK-57 aligned | Media capture | `takePictureAsync` defaults to `quality: 1` — always pass explicit quality (~0.7). Output lands in the **cache dir** — move to document dir immediately (06-media-pipeline). |
| `expo-image-manipulator` | SDK-57 aligned | Downscale before upload | — |
| `expo-image` | align with Expo SDK 57 — **verify at install** | Image rendering: disk-cached, downsamples to layout size — required for media thumbnails on the 2 GB device class (design-system) | Consumed through `@bolusi/ui` components; installed via `npx expo install`. |
| `@expo/vector-icons` | align with Expo SDK 57 — **verify at install** | Icon set (already in the Expo SDK dependency tree — no new native dep) | Consumed only through `@bolusi/ui`'s whitelisted `Icon` component (design-system); direct glyph imports in screens fail review. |
| `expo-file-system` | SDK-57 aligned | New `File`/`FileHandle` API (`offset` + `readBytes`) is the chunked-upload primitive | **Legacy re-exports on the main entry THROW at runtime in SDK 57** — never import `FileSystem.uploadAsync` etc. There is **NO native resumable upload**; chunked resumable upload is hand-rolled (06-media-pipeline / `api/03-media.md`). |
| `expo-location` | align with Expo SDK 57 — **verify at install** | `LocationPort` implementation in `apps/mobile` (§3.2 `@bolusi/core` row) — feeds the envelope `location` stamp | Must honor the port's non-blocking contract (§3.2): serve the best available / last-known fix (cached ≤ 60 s acceptable) and return `null` when there is none or permission is denied — never block a command waiting on a fresh GPS fix. Installed via `npx expo install`. |
| `expo-notifications` | SDK-57 aligned | Push via FCM HTTP v1 | Needs `android.googleServicesFile` + FCM service-account key uploaded to EAS; `getExpoPushTokenAsync({ projectId })`; explicit Android channel via `setNotificationChannelAsync`. Dev build required on Android. |
| `expo-background-task` + `expo-task-manager` | SDK-57 aligned | Opportunistic sync/upload retry only | 15-min floor, OS-controlled, unreliable on cheap OEM Android — **never a correctness dependency**; the foreground drain loop is the primary driver (api/01-sync §5, 06-media-pipeline). `expo-background-fetch` is deprecated — forbidden. |
| `kysely-generic-sqlite` | **2.0.0** | Shim base for the custom client Kysely dialect over the db-client wrapper | No official op-sqlite Kysely dialect exists — we own this shim (thin, in `@bolusi/db-client`). |

### 2.3 Shared pure-TS (usable on Hermes AND Node)

| Package | Version | Why | Caveat |
| ------- | ------- | --- | ------ |
| `zod` | **4.4.3** | Envelope + payload + DTO validation, shared client↔server | Deduped via `pnpm.overrides` (§2.1.6). |
| `canonicalize` | **3.0.0** | RFC 8785 JCS — the hash preimage (05 §3), same implementation both sides, lives in `@bolusi/core` | Single-maintainer, sparse releases (spec is frozen — acceptable). **RFC 8785 test vectors MUST run in CI on both Node and the Hermes runtime** (§5.6) — JCS number serialization depends on spec-correct ES number→string. Guard inputs against `undefined`/`BigInt`/`NaN`/`Infinity`. |
| `kysely` | **0.29.3 EXACT** | Typed query builder, client (SQLite dialect) + server (Postgres) | 0.x minors break (§2.1.2). `Migrator`/`FileMigrationProvider` import from `'kysely/migration'`, not the root. Requires Node ≥ 22 on server. |
| `@noble/curves` | **2.2.0** | Ed25519 for **server + shared/test code only** — RFC 8032-interoperable with quick-crypto | ESM-only, `.js`-extension subpath imports (`@noble/curves/ed25519.js`). Never the on-device signer (Hermes too slow). |
| `@noble/hashes` | **2.2.0** | SHA-256 for server + tests | Same ESM note. Never on-device hot paths. |

UUIDv7 (`id`, `entityId` — 05 §2.1) is **implemented inside `@bolusi/core`** over the injected crypto port's `randomBytes` (48-bit ms timestamp + version/variant bits + random). No uuid library dependency; deterministic-testable via injected rng/clock.

### 2.4 Server (`apps/server`, `packages/db-server`)

| Package | Version | Why | Caveat |
| ------- | ------- | --- | ------ |
| `hono` | **4.12.30** | Routing + RPC type-sharing (`AppType` + `hc`), `bearerAuth`, `bodyLimit`, `streamSSE` | RPC type inference degrades IDE/tsc at scale — sub-routers + precompiled types from day one (§4.3). |
| `@hono/node-server` | **2.0.8** | Node adapter; **first-class `upgradeWebSocket`** (with `ws`, `WebSocketServer({ noServer: true })` passed as `serve({ ..., websocket })`) | Node ≥ 20 floor (we run 22). Fresh 2.x line — exact pin, changelog review per bump (§2.1.4). `upgradeWebSocket` mutates headers internally — keep header-mutating middleware (CORS etc.) off WS routes. |
| `ws` | 8.x *bootstrap-pin* | WebSocket server impl behind `upgradeWebSocket` | The separate **`@hono/node-ws` package is DEPRECATED — never install it**; pre-2026 tutorials showing it are wrong. |
| `@hono/zod-validator` | **0.8.0** | Typed request validation (`zValidator` → `c.req.valid`) | Requires zod v4 (§2.1.6). Runs AFTER gzip request-decompression middleware — order owned by `api/00-conventions.md` (bearerAuth → bodyLimit on wire bytes → custom `DecompressionStream('gzip')` middleware **with its own decompressed-size cap** [gzip-bomb defense; `bodyLimit` counts compressed bytes only] → zValidator). |
| `pg` | 8.x *bootstrap-pin* | Postgres driver under built-in `PostgresDialect` | Tenant context is **transaction-local only**: `set_config('app.tenant_id', $1, true)` inside the request transaction. Session-level `SET` on pooled connections is **forbidden** (leaks tenant across requests). |
| `kysely-ctl` | **0.21.0** | Migrations + seeds CLI (official) | — |
| `kysely-codegen` | **0.20.0** | Generates the server `Database` interface from the migrated dev DB | Flow: migrate dev DB → codegen → commit generated types (§3.2 db-server). |

### 2.5 Tooling / test-only

| Package | Version | Why | Caveat |
| ------- | ------- | --- | ------ |
| `vitest` | *bootstrap-pin* | Unit + integration + chaos harness (`@bolusi/harness`) runner (root projects config) | — |
| `@electric-sql/pglite` | *bootstrap-pin* | In-process Postgres for fast server integration tests (built-in kysely PGlite dialect) | Real Postgres (RLS suite) still runs at merge gate (§5.6) — do not trust WASM as the only RLS witness. |
| `better-sqlite3` | *bootstrap-pin* | Node SQLite driver (built-in kysely `SqliteDialect`) backing **simulated devices** in the harness and the dual-dialect applier suite | Test-only; never imported by shipping packages. |
| `eslint` | 9.x flat config *bootstrap-pin* | Lint + boundary enforcement + custom rules (§5.2) | — |
| `prettier` | 3.x *bootstrap-pin* | Formatting, one root config | — |

### 2.6 Forbidden / cautioned packages

| Package | Status | Reason |
| ------- | ------ | ------ |
| `@hono/node-ws` | **forbidden** | Deprecated; `upgradeWebSocket` comes from `@hono/node-server` 2.x. |
| `expo-background-fetch` | **forbidden** | Deprecated; use `expo-background-task`. |
| `expo-sqlite` | not installed in v0 | Designated **swap target** behind the db-client wrapper; installing both invites duplicate-SQLite symbol conflicts. |
| `kysely-expo` | forbidden | Tracks expo-sqlite (which we don't use) in SDK lockstep; we own the op-sqlite dialect shim instead. |
| Any pure-JS crypto on device hot paths (noble on Hermes, js argon2/pbkdf2) | **forbidden on device** | 100x+ too slow on Hermes; quick-crypto is the sole on-device provider. PIN KDF: argon2id m=32768 KiB / t=3 / p=1 / 32-byte output, documented floor m=19456/t=2/p=1 only if on-device benchmark on the 2 GB target exceeds 300 ms (api/02-auth owns the parameter decision record). |
| `react-native-reanimated` | cautioned — avoid in v0 | Reported ~25–30% Android memory inflation on RN 0.85/0.86 Hermes; re-verify against the expo issue tracker before adopting. v0 UI must not need it. |
| Drizzle, Fastify, Bun runtime | rejected in D3 | Do not re-litigate in tasks. |

## 3. Monorepo layout

### 3.1 Tree

```
bolusi/
├─ pnpm-workspace.yaml          # workspaces + catalog (single pin location)
├─ package.json                 # packageManager, engines, root scripts, pnpm.overrides
├─ tsconfig.json                # solution file: project references only
├─ docker-compose.yml           # postgres:16-alpine (dev + rls-test DBs)
├─ apps/
│  ├─ mobile/                   # @bolusi/mobile   — Expo SDK 57 app (dev-client)
│  └─ server/                   # @bolusi/server   — Hono on Node 22
├─ packages/
│  ├─ core/                     # @bolusi/core     — op log, projection engine, command
│  │                            #   runtime, sync client core, JCS, UUIDv7. PURE TS.
│  ├─ modules/                  # @bolusi/modules  — module manifests (v0: notes)
│  ├─ schemas/                  # @bolusi/schemas  — zod: op envelope, API DTOs, WS msgs
│  ├─ db-client/                # @bolusi/db-client — op-sqlite wrapper + kysely dialect
│  ├─ db-server/                # @bolusi/db-server — kysely+pg, forTenant, migrations,
│  │                            #   codegen types, RLS policy migrations
│  ├─ i18n/                     # @bolusi/i18n     — label catalog (id/en) + key types
│  ├─ ui/                       # @bolusi/ui       — design system: tokens + components
│  │                            #   (contents owned by design-system; Hermes only)
│  ├─ test-support/             # @bolusi/test-support — golden vectors, fakes,
│  │                            #   determinism kit (PRNG/FakeClock/IdSource),
│  │                            #   driver-conformance suite (private, test-only)
│  └─ harness/                  # @bolusi/harness  — chaos harness + 2-device simulator
│                               #   (private, test-only, runs on Node)
└─ tooling/
   ├─ tsconfig/                 # @bolusi/tsconfig — base tsconfigs (§4)
   └─ eslint/                   # @bolusi/eslint-config + eslint-plugin-bolusi (§5.2)
```

### 3.2 Workspace responsibilities

| Workspace | Runtime | Contents (owning docs) |
| --------- | ------- | ---------------------- |
| `@bolusi/schemas` | Hermes + Node | Zod schemas: signed-core envelope (05 §2.1), sync DTOs (api/01-sync), auth DTOs, WS message schemas (hc's `$ws()` does NOT type socket payloads — these schemas do), and the error-envelope schema (api/00 §7). WS-message and error-envelope Zod schemas live HERE, never in `@bolusi/core` (api/00 §12.1/§14). Money fields `z.number().int()` always (05 §3). Depends on `zod` only. |
| `@bolusi/i18n` | Hermes + Node | Label catalog `id`/`en` + generated key union type (mechanism owned by 07-i18n). No internal deps. |
| `@bolusi/ui` | Hermes only | Design system: tokens (`tokens.ts`) + shared RN components (whitelisted `Icon`, PinPad, sync chips, …) — contents owned by the design-system doc. Depends on React Native, `expo-image`, `@expo/vector-icons`. **Contended shared package** (CLAUDE.md §4): changes serialize and land before dependents. |
| `@bolusi/test-support` | Node + Hermes (test-only) | Golden vector files (Ed25519 / SHA-256 / RFC 8785 — one shared fixture set), the determinism kit (mulberry32 PRNG, FakeClock, IdSource, seeded keypairs, op script generator — testing-guide §3.3), shared fakes, and the driver-conformance suite (identical statement set run against better-sqlite3 in CI and op-sqlite on device; the driver handle is injected by the runner). Never imported by shipping source. |
| `@bolusi/core` | Hermes + Node | Op append/verify (hash, chain, sign via crypto port), canonical ordering, projection engine (04 §4 head/re-fold/rebuild), command runtime (04 §5.1), sync client loop (api/01-sync §6), JCS wrapper over `canonicalize`, UUIDv7. **Platform-free**: all effects behind injected ports — `CryptoPort` (sha256, ed25519, argon2id, randomBytes), `ClockPort` (`now()` — no `Date.now()` outside the runtime stamp point), `TransportPort` (push/pull/media), `KeyStorePort`, `LocationPort` (`getBestFix(): { lat, lng, accuracyMeters } | null` — non-blocking: returns the best available fix or `null`, never waits on GPS; a cached fix up to **60 s** old is acceptable; feeds the envelope `location` stamp, 04 §5.1 / 05 §2.1), and a Kysely instance (`ProjectionDb`, 04 §2) handed in by db-client/db-server. |
| `@bolusi/modules` | manifest: Hermes + Node; screens: Hermes only | `defineModule` manifests (04 §1). **Split entry points via `package.json` `exports`:** `@bolusi/modules/notes` = platform-free manifest (operations, projections, commands, queries); `@bolusi/modules/notes/screens` = RN components. Server and harness may import only the manifest subpath; only `apps/mobile` may import `*/screens` (lint-enforced, §3.4). |
| `@bolusi/db-client` | Hermes only | The thin DB-access wrapper (**the only importer of `@op-engineering/op-sqlite`** in the repo): exports one module-singleton connection (`open({ name, encryptionKey })`, SQLCipher key from SecureStore), transaction/batch/prepared-statement surface, and the custom Kysely dialect built on `kysely-generic-sqlite` 2.0.0 **against the wrapper, not op-sqlite directly** — keeping expo-sqlite a swap target. Client schema DDL + local migrations for op-log, projection, bookkeeping tables. |
| `@bolusi/db-server` | Node only | Kysely + `PostgresDialect`, migrations (kysely-ctl; **DB migrations serialize globally** — CLAUDE.md §4), kysely-codegen output, RLS policy migrations, and **`forTenant(tenantId)` — the ONLY exported way to query tenant tables** (FR-1039). It opens a transaction, runs `set_config('app.tenant_id', $1, true)`, and yields a tenant-bound Kysely handle. The raw pool/db handle is not exported (migration runner excepted). RLS policies `USING (tenant_id = current_setting('app.tenant_id')::uuid)` are the enforcement layer; `forTenant` is ergonomics — both mandatory (D3/Q2). |
| `@bolusi/harness` | Node only | Chaos harness + N-device simulator: each simulated device = `@bolusi/core` + better-sqlite3-backed Kysely + noble crypto port + fetch transport, seeded via the `@bolusi/test-support` determinism kit + fakes; server side = `@bolusi/server` app in-process on PGlite or over HTTP to local dev server. Scenario semantics owned by the testing guide (testing-guide); this package is the machinery. Exit-criterion D4 runs here. |
| `@bolusi/server` | Node only | Hono app: sub-routers `auth`, `devices`, `users`, `tenant`, `sync`, `media`, `push`, `realtime` (endpoint map owned by api/00 §1), middleware chain per api/00-conventions, WS via `upgradeWebSocket` + SSE fallback via `streamSSE`, push sender (FCM v1 via Expo push; delivery contract owned by `api/04-push.md`). Exports `AppType` from a **types-only subpath** `@bolusi/server/client` (§4.3). |
| `@bolusi/mobile` | Hermes | Expo app: screens from `@bolusi/modules/*/screens` built on `@bolusi/ui`, `useQuery`/`useCommand` bindings, quick-crypto `CryptoPort` impl, SecureStore `KeyStorePort` impl, expo-location-backed `LocationPort` impl (§2.2), hc-typed `TransportPort` impl, sync trigger wiring (NetInfo, debounce, foreground interval, background task, pull-to-refresh — api/01-sync §5), media capture/upload driver (06-media-pipeline). |

### 3.3 Import boundary rules (dependency direction)

An edge means "may import". Anything not listed is forbidden.

| From ↓ | may import |
| ------ | ---------- |
| `schemas` | `zod` only |
| `i18n` | (nothing internal) |
| `core` | `schemas` (+ `canonicalize`, `kysely` types) |
| `ui` | `i18n` (key types only), React Native, `expo-image`, `@expo/vector-icons` |
| `modules` (manifest) | `core`, `schemas`, `i18n` (key types only) |
| `modules/*/screens` | manifest of same module, `core` (hooks types), `i18n`, `ui`, React Native |
| `db-client` | `core`, `schemas`, op-sqlite, `kysely-generic-sqlite` |
| `db-server` | `core`, `schemas`, `kysely`, `pg` |
| `apps/server` | `core`, `modules` (manifest subpaths ONLY, never `*/screens`), `schemas`, `db-server`, `i18n`, hono stack, noble |
| `apps/mobile` | `core`, `modules` (incl. screens), `schemas`, `db-client`, `i18n`, `ui`, Expo/RN stack, quick-crypto; **type-only** `@bolusi/server/client` (§4.3) |
| `test-support` | `core`, `schemas`, `kysely` (types), noble (DB drivers are injected by the runner, never imported) |
| `harness` | `core`, `modules` (manifest only), `schemas`, `test-support`, `@bolusi/server` (in-process, test-only), better-sqlite3, PGlite, noble |

Hard rules:

1. `packages/*` never import `apps/*` (sole exception: `harness` → `@bolusi/server`, test-only).
2. `db-client` and `db-server` never import each other; nothing outside them imports a DB driver.
3. `core`, `schemas`, `i18n`, `modules` manifests are **platform-free**: no `node:*`, no `react-native*`, no `expo*`, no `pg`, no `hono`, no `@op-engineering/*`, no `react-native-quick-crypto`, no `ws`.
4. The only app→app edge is `mobile` → `server` and it is **type-only** (§4.3).
5. Spec docs are not edited as an implementation side effect (CLAUDE.md §4) — same applies to this boundary table.
6. `test-support` and `harness` are **test-only**: shipping source never imports them — they appear only in test files, the harness itself, and CI entry points.

### 3.4 How platform-freeness is enforced (three locks)

| Lock | Mechanism |
| ---- | --------- |
| tsconfig | Platform-free packages compile with `"types": []` and `"lib": ["ES2022"]` — no DOM, no Node, no RN ambient types can even resolve. |
| ESLint | Flat-config `no-restricted-imports` blocks per workspace implementing the §3.3 matrix exactly (named config block `bolusi/boundaries`); forbidden patterns include `node:*`, `react-native*`, `expo*`, `@op-engineering/*`, `pg`, `hono*`, `ws`. `*/screens` subpath imports are forbidden everywhere except `apps/mobile`. |
| CI | `@bolusi/core`/`schemas`/`modules`-manifest unit tests execute on Node **and** the JCS/crypto vector suite executes on the Hermes runtime (§5.6) — a platform leak fails one of the two. |

## 4. TypeScript configuration

### 4.1 Base config (`tooling/tsconfig`)

- `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true` (load-bearing: the signed core forbids optional keys — nullable fields are always present-and-null, 05 §3; this flag makes `undefined`-vs-`null` a compile error), `verbatimModuleSyntax: true`, `isolatedModules: true`.
- `target`/`lib`: `ES2022` for all packages (Hermes-safe, Node-22-safe). `apps/mobile` extends Expo's base tsconfig; `apps/server` + packages use `module: NodeNext` / `moduleResolution: NodeNext` (required for noble's ESM-only `.js` subpath imports; all workspaces are `"type": "module"`).
- Variants: `base.json` (platform-free: `types: []`), `node.json` (adds `types: ["node"]`), `react-native.json`.

### 4.2 Project references + build model

- Root `tsconfig.json` is a solution file (`files: []`, `references` to every workspace). `pnpm typecheck` = `tsc -b`.
- Every `packages/*` and `apps/server` is `composite: true`, emits ESM + `.d.ts` to `dist/`, and is consumed **from `dist/`** by both Node and Metro (no Metro source-resolution hacks). `pnpm dev` runs `tsc -b --watch` alongside Metro / the server.
- `apps/mobile` does not emit: it typechecks `--noEmit` against built `.d.ts` after `tsc -b` (composite would force emit through Expo's config).
- Metro config: monorepo `watchFolders` for `packages/*`; package-exports resolution stays on (RN default) — required for the `@bolusi/modules` subpath split and noble-style exports.

### 4.3 Hono RPC `AppType` flow (research-mandated shape)

- `apps/server` is built as **chained sub-routers**, composed into one app; `export type AppType = typeof routes`.
- `@bolusi/server` exposes a subpath export `@bolusi/server/client` whose built output contains **only** `export type { AppType }` — zero runtime code. This is the single permitted app→app import, `import type` only (enforced by `verbatimModuleSyntax` + eslint `consistent-type-imports` + the boundary rule matching value-imports of `@bolusi/server` outside harness).
- Types are **precompiled** (`tsc -b` emits the `.d.ts`); consumers never re-infer the router (the documented RPC IDE/tsc blow-up mitigation).
- `@bolusi/core`'s sync engine does **not** know Hono: it speaks `TransportPort` typed by `@bolusi/schemas` DTOs. The hc-typed client lives in the thin `TransportPort` adapters (`apps/mobile`, `harness`), keeping core server-free and the wire types checked end-to-end.

## 5. Toolchain

### 5.1 pnpm

- `pnpm-workspace.yaml`: `apps/*`, `packages/*`, `tooling/*`; `catalog:` block holds every §2 pin once.
- `.npmrc`: `save-exact=true`, `engine-strict=true`.
- Root scripts (canonical names — tasks and CI use these, never ad-hoc commands):

| Script | Does |
| ------ | ---- |
| `pnpm typecheck` | `tsc -b` |
| `pnpm lint` | eslint (flat config, all custom rules at `error`) |
| `pnpm test` | vitest unit projects (all packages) |
| `pnpm test:server` | server integration suite vs PGlite |
| `pnpm test:rls` | same integration suite vs dockerized Postgres (RLS witness) |
| `pnpm test:appliers` | dual-dialect applier suite: every applier vs better-sqlite3 AND PGlite (04 §2) |
| `pnpm chaos` | `@bolusi/harness` chaos scenarios (D4) |
| `pnpm simulate` | interactive/scripted N-device simulator (§6.3) |
| `pnpm db:up` / `db:migrate` / `db:seed` / `db:codegen` | compose up / kysely-ctl migrate / seed / regenerate types |
| `pnpm dev` | `tsc -b --watch` + server (tsx watch) + Metro |

### 5.2 ESLint (flat config, `tooling/eslint`)

`@bolusi/eslint-config` (shared flat config) + `eslint-plugin-bolusi` (local workspace plugin). Custom rules — all `error`, no inline-disable without a linked task:

| Rule | Scope | Enforces |
| ---- | ----- | -------- |
| `bolusi/no-hardcoded-strings` | `apps/mobile`, `packages/modules/**/screens` | No user-visible string literals in JSX/alert/toast/notification calls — everything through the label catalog API (mechanism + key format owned by 07-i18n). D4 exit checkbox "zero hardcoded strings" hangs off this rule. |
| `bolusi/no-float-money` | `packages/schemas`, `packages/modules` | In payload/command/query schema files: every `z.number()` must chain `.int()`; non-integer numeric literals and `parseFloat`/`Number.parseFloat`/`toFixed` on identifiers matching `/(amount|price|cost|total|fee|idr)/i` are errors. Money is integer IDR, floats never (05 §3). **Schema-file convention (bootstrap):** the numeric-literal prong applies to all of `packages/schemas/src/**` plus `packages/modules` files named `*.schema.ts(x)` or `schema\|schemas\|ops\|operations\|commands\|queries.ts` — module tasks MUST use these names for payload/command/query schema files; other files (e.g. screens with `opacity: 0.5`) keep only the `z.number()` and money-identifier prongs. |
| `bolusi/no-op-table-update` | whole repo | Flags Kysely `updateTable`/`deleteFrom` targeting operation-log tables and raw SQL matching `UPDATE`/`DELETE ... operations`. Allowlist (rule option, exact file list): core's sync/oplog bookkeeping modules may UPDATE **bookkeeping columns only** (`syncStatus`, `syncedAt`, `rejectionCode`, `rejectionReason`) and the server's acceptance path may set (`serverSeq`, `receivedAt`, `clockSkewFlagged`) on insert. Signed-core columns are immutable everywhere; DELETE is never allowed (05 §1, §2.3–2.4). |
| `bolusi/boundaries` (config block of `no-restricted-imports`) | whole repo | The §3.3 matrix + §3.4 platform-free lists + "only db-client imports op-sqlite" + "no `@hono/node-ws`, no `expo-file-system/legacy`, no `expo-background-fetch`". |

Plus stock: `@typescript-eslint` strict-type-checked where cheap, `consistent-type-imports`, no-floating-promises in apps/server.

### 5.3 Prettier

One root config; no per-package overrides. Runs as a lint-staged step in the pre-commit hook (hooks mandatory, never `--no-verify` — CLAUDE.md §2.10).

### 5.4 Vitest layout

- Root vitest projects config; unit tests colocated `*.test.ts` per package.
- `apps/server/test/integration/`: boots the Hono app in-process on the kysely PGlite dialect (fast) — the identical suite re-runs against real Postgres in `pnpm test:rls` (RLS + `set_config` semantics witnessed on the real engine).
- Dual-dialect applier suite lives in `packages/modules/test/` and runs every applier against better-sqlite3 and PGlite (04 §2 dialect-neutral guarantee).
- **Chaos harness location: `packages/harness`** (`@bolusi/harness`, private). Vitest with long timeouts; scenarios (out-of-order arrival, clock skew, interrupted/resumed sync, tampered chains, days-offline merge, idempotent replay, projection rebuild at volume — D4) are enumerated and owned by the testing guide; this doc owns only where they live and how they run.
- RFC 8785 vector suite: vector data lives in `@bolusi/test-support` (the shared fixture set also carrying the Ed25519/SHA-256 interop vectors); the runner is `packages/core/test/jcs-vectors/` — spec appendix vectors + Bolusi-specific cases (envelope with nulls, integer money, ms-epoch timestamps) — runs on Node (vitest) and on Hermes (§5.6 stage 6).

### 5.5 EAS build profiles (`apps/mobile/eas.json`)

| Profile | Settings | Use |
| ------- | -------- | --- |
| `development` | `developmentClient: true`, internal distribution, Android APK, channel `dev` | Daily dev loop; required for quick-crypto/op-sqlite/push/SQLCipher testing. |
| `preview` | release build, internal distribution, Android APK, channel `preview` | Physical 2 GB device validation (D4 exit criterion) + on-device benchmarks (argon2id ≤ 300 ms check, write-throughput). |
| `test` | `preview` settings + `env: { "BOLUSI_TEST_HARNESS": "1" }`, channel `test` | On-device test/QA builds with the in-app harness hooks enabled (the testing guide owns what the flag exposes). Never distributed to users. |
| `production` | placeholder only | Out of v0 use; exists so the file shape doesn't churn later. |

FCM v1 credentials: `google-services.json` wired via `android.googleServicesFile`, service-account key uploaded to EAS (never committed). New native dep or config-plugin change ⇒ new dev-client build for the whole team (use `npx expo-doctor` + fingerprint diff in CI to detect).

### 5.6 CI pipeline (stage outline)

| # | Stage | Command / mechanism | Gate |
| - | ----- | ------------------- | ---- |
| 1 | install | `pnpm install --frozen-lockfile`; fail on duplicate zod in lockfile | every PR |
| 2 | lint + boundaries | `pnpm lint` | every PR |
| 3 | typecheck | `pnpm typecheck` (`tsc -b`) | every PR |
| 4 | unit | `pnpm test` | every PR |
| 5 | JCS vectors (Node) | part of stage 4 (`packages/core/test/jcs-vectors`) | every PR |
| 6 | **JCS + crypto vectors (Hermes)** | Vector suite bundled standalone (no imports beyond `canonicalize` + core serialization; vector data from `@bolusi/test-support`) and executed on the **Hermes VM matching the pinned RN version**. Preferred: `hermesc`-compiled bundle run on the Hermes binary shipped with the RN toolchain; guaranteed fallback if that binary is unavailable in CI: run the same suite inside the Android-emulator job. The bootstrap task verifies which path works and records it here. | every PR |
| 7 | Ed25519 interop | noble sign → verify against the `@bolusi/test-support` fixture set (Node side of the quick-crypto ⇄ noble RFC 8032 interop contract) | every PR |
| 8 | server integration | `pnpm test:server` (PGlite) | every PR |
| 9 | RLS witness | `pnpm test:rls` vs dockerized `postgres:16` — includes adversarial fail-closed tests (query without `set_config` returns zero rows; cross-tenant probe returns zero rows) | merge gate |
| 10 | dual-dialect appliers | `pnpm test:appliers` | merge gate |
| 11 | chaos harness | `pnpm chaos` | merge gate |
| 12 | device lane | EAS dev-client build (fingerprint-triggered on native change) + on-device smoke: quick-crypto side of the interop vectors, argon2id timing, SQLCipher open | native change / scheduled |

Security-surface tasks additionally ship adversarial tests BEFORE review (CLAUDE.md §2.5) — the gzip-decompression middleware (malformed gzip, truncated stream, bomb), RLS probes, and signature/chain tampering all have named suites; the testing guide owns their contents.

## 6. Dev environment

### 6.1 Services

- `docker-compose.yml`: `postgres:16-alpine`, port 5432, named volume, init script creating `bolusi_dev` and `bolusi_rls_test` databases. Nothing else (no redis, no queues — out of v0 scope).
- `apps/server/.env` (gitignored, `.env.example` committed): `DATABASE_URL`, `PORT=3000`. `apps/mobile`: `EXPO_PUBLIC_API_URL` via `app.config.ts`.

### 6.2 Bootstrap sequence (must work from a clean clone)

```
corepack enable && pnpm install
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm dev            # tsc -b --watch + server :3000 + Metro
```

Seed (`packages/db-server/seeds/`): one dev tenant, one store, two users (`owner` with role `main_owner`, `staff` with role `staff` — 02-permissions §10), two **pre-enrolled simulated devices** with Ed25519 keypairs generated via noble (test keys, committed as fixtures, clearly marked never-production), and a small set of valid signed `notes` ops. Seed is idempotent (re-run = no-op).

### 6.3 Running a 2-simulated-device sync locally

```
pnpm simulate -- --devices 2 --scenario notes-merge
```

`@bolusi/harness` spins two simulated devices (each: `@bolusi/core` + better-sqlite3 Kysely + noble `CryptoPort` + fetch `TransportPort` → `http://localhost:3000`, authenticated as the two seeded devices), then drives the scenario: device A and B both offline → both edit the same note → reconnect → assert both projections converge byte-identically and conflicts surface per the Conflict state machine (detected → auto_resolved | surfaced; 03-state-machines). `--repl` drops into an interactive prompt (`deviceA.exec('notes.createNote', {...})`, `deviceB.goOffline()`, `sync()`, `dump()`). The same machinery runs headless in CI stage 11 with in-process server + PGlite (no docker needed).

### 6.4 Physical-device loop (2 GB Android target)

1. `eas build --profile development --platform android`; install APK on device.
2. Server on LAN: `EXPO_PUBLIC_API_URL=http://<lan-ip>:3000` (Android emulator: `http://10.0.2.2:3000`).
3. Two physical devices (or device + emulator) against the same local server = the manual counterpart of §6.3, and the D4 reference-module exit run.

## 7. Bootstrap-time records (single checklist for the repo-init task)

The repo-init task must, in order: pin the *bootstrap-pin* rows (§2) into the catalog; record exact `packageManager` (pnpm 10.x.y) and TypeScript versions in §1; verify op-sqlite's bundled SQLite/SQLCipher versions from its CMake/podspec and record them in §2.2; smoke-test quick-crypto's argon2 option names on the dev build; verify the Hermes-VM CI path (§5.6 stage 6) and record the chosen mechanism; confirm `@hono/zod-validator` 0.8.0 + zod 4.4.3 type-check together in the lockfile. Each record lands as an edit to THIS doc in the same PR.

### Bootstrap records (2026-07-14, task 01)

1. **Bootstrap-pin resolutions (catalog, `pnpm-workspace.yaml`)** — all registry-verified exact at bootstrap: `vitest 4.1.10`, `@electric-sql/pglite 0.5.4`, `better-sqlite3 12.11.1`, `eslint 9.39.5` (eslint 10.x existed; §2.5 pins the 9.x flat-config line), `prettier 3.9.5`, `ws 8.21.1`, `pg 8.22.0`. Support pins added to the catalog: `typescript 5.9.3`, `typescript-eslint 8.64.0`, `@types/node 22.20.1`, `@types/pg 8.20.0`, `@types/ws 8.18.1`, `lint-staged 17.0.8`, `tsx 4.23.1`. quick-crypto peer pins: `react-native-nitro-modules 0.36.1` (satisfies ≥ 0.31.2), `react-native-quick-base64 3.0.1` (satisfies ≥ 3.0.0). Every §2 exact-pin row resolved at exactly its stated version.
2. **Expo SDK-57-aligned installs** (`npx expo install`, then normalized to exact in `apps/mobile/package.json`): `expo 57.0.4` (catalog), `react 19.2.3`, `react-native 0.86.0`, `expo-dev-client 57.0.5`, `expo-secure-store 57.0.0`, `expo-camera 57.0.1`, `expo-image-manipulator 57.0.2`, `expo-image 57.0.0`, `@expo/vector-icons 15.1.1`, `expo-file-system 57.0.0`, `expo-location 57.0.2`, `expo-notifications 57.0.3`, `expo-background-task 57.0.2`, `expo-task-manager 57.0.2`, `expo-status-bar 57.0.0`, `expo-build-properties 57.0.3` (required peer of quick-crypto's config plugin — the plugin exists as `react-native-quick-crypto/app.plugin.js` and is registered in `app.config.ts`), `@types/react 19.2.17`.
3. **`packageManager` + TypeScript** recorded in §1: `pnpm@10.34.5`, `typescript@5.9.3`.
4. **op-sqlite bundled engines** recorded in §2.2: SQLite `3.51.3`, SQLCipher `4.14.0` (read from the installed 17.1.2 package's `cpp/` sources; the podspec confirms the `package.json` `"op-sqlite"` config block drives `sqlcipher`/`performanceMode`).
5. **quick-crypto argon2 option-name smoke test** — **TODO(device)**: requires the dev-client build on hardware; not verifiable in the bootstrap environment. Owner: **task 27 (device-gates)** runs the smoke + timing on the 2 GB target (task 14 consumes the parameters per api/02-auth).
6. **Hermes-VM CI path (§5.6 stage 6)** — verified at bootstrap: RN 0.86 depends on the npm package `hermes-compiler@250829098.0.14`, which ships a working `hermesc` for linux64/osx/win64 (`hermesc -emit-binary` smoke-tested green on CI-class linux). That package ships **no host Hermes VM**, so *executing* the vector bytecode needs either a built Hermes CLI or the Android-emulator fallback lane. Final mechanism: **TODO — task 03 (crypto-canonical)**; CI carries the named `jcs-vectors-hermes` placeholder job documenting both candidate paths.
7. **`@hono/zod-validator` 0.8.0 + zod 4.4.3 co-typecheck — CONFIRMED**: `apps/server/src/app.ts` wires `zValidator` into a route and `tsc -b` is green; the lockfile resolves a single `zod@4.4.3` (enforced by `scripts/check-single-zod.mjs` in CI stage 1 + unit tests).
8. **Secret scanning**: gitleaks `8.30.1` — pre-commit hook (`.githooks/pre-commit`, installed via the root `prepare` script) + CI (unit job installs the binary sha256-pinned to `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb` for SEC-SECRET-02; `gitleaks/gitleaks-action@v2` scans history).
9. **CI stages 7–8 deferred as named placeholders**: `ed25519-interop` (stage 7 → task 03) and `server-integration` (stage 8 → task 12) exist in `.github/workflows/ci.yml` as green no-op jobs echoing their owner — same pattern as the merge-gate placeholders (stages 9–12). They become real in their owning tasks; nothing may treat the placeholder echo as coverage.
10. **Sanctioned deviation from §4.1 "all workspaces are `type: module`"**: `apps/mobile/package.json` intentionally omits `"type": "module"` — Metro/Expo resolve the app's own files by extension (`metro.config.cjs` is CJS; app source goes through Metro, not Node's ESM loader), and forcing ESM semantics on the app package breaks tooling expectations. The rule stands for every emitting workspace (`packages/*`, `apps/server`) and the root.
