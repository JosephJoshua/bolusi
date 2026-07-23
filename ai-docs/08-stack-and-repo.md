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
| Database (client) | SQLite via op-sqlite (**no SQLCipher** — D22/task 148) | Single connection, WAL (§2.2 caveats). At-rest confidentiality is app-layer AES-256-GCM on the sensitive columns (10-db §9.7). |
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
| `@op-engineering/op-sqlite` | **17.1.2** | Fastest RN SQLite; `executeBatch`/prepared statements/`executeRaw` fit the append-only op log + projection rebuilds on 2 GB devices; at-rest confidentiality is app-layer, NOT `open({encryptionKey})` (D22) | **Exactly ONE open connection per DB app-wide** (documented op-sqlite rule) — concurrency comes from WAL, never a second connection. Single-maintainer project: all access goes through the `@bolusi/db-client` wrapper so **expo-sqlite stays a swap target** (if swapped: `withExclusiveTransactionAsync` is mandatory — the plain variant is not isolated). Config via `package.json` block, no config plugin: `"op-sqlite": { "performanceMode": true }`. **`sqlcipher` is OFF (D22/task 148).** It was ON, and its OpenSSL collided with react-native-quick-crypto's: `:app:mergeReleaseNativeLibs` refused two `lib/arm64-v8a/libcrypto.so` and the Android APK could not be assembled at all. `pickFirst` was rejected (upstream calls it "not a real fix"; one branch silently runs the DB cipher on an OpenSSL it was never built against), so at-rest encryption moved to the application layer (10-db §9.7). The prediction in this row was right about the mechanism and wrong about the platform — it landed on **Android** against `libcrypto`, not iOS against `libsqlite`. Verify bundled SQLite/SQLCipher versions in the repo's CMake/podspec at bootstrap. **Bootstrap record (17.1.2): bundled SQLite `3.51.3` (`cpp/sqlite3.h` + `cpp/sqlcipher/sqlite3.h`), SQLCipher `4.14.0` (`CIPHER_VERSION_NUMBER`, `cpp/sqlcipher/sqlite3.c`).** |
| `react-native-quick-crypto` | **1.1.6** | The **only on-device crypto provider**: Ed25519 keygen/sign/verify, sync SHA-256, argon2id. Pure-JS crypto on Hermes is 100x+ too slow for hot paths (no JIT) | Requires **New Architecture + Nitro Modules + dev build** (never Expo Go). Peers below must be installed with it, plus its Expo config plugin. argon2 option names (`memoryCost`/`timeCost`/`parallelism`) mirror Node's experimental surface — smoke-test on install. |
| `react-native-nitro-modules` | ≥ 0.31.2 (peer; pin exact satisfying at bootstrap) | quick-crypto peer | — |
| `react-native-quick-base64` | ≥ 3.0.0 (peer; pin exact at bootstrap) | quick-crypto peer | — |
| `expo-secure-store` | SDK-57 aligned | Device signing key + at-rest column-encryption key + device token storage | Values **< 2 KB** (historical iOS ceiling ~2048 bytes — design ceiling, handle native errors). It is **encrypted-at-rest storage, NOT a non-extractable-key enclave**: app code can read keys back; TEE backing is device-dependent and not guaranteed — no spec doc may claim "hardware-backed non-extractable keys". `requireAuthentication` needs a dev build. |
| `expo-camera` | SDK-57 aligned | Media capture | `takePictureAsync` defaults to `quality: 1` — always pass explicit quality (~0.7). Output lands in the **cache dir** — move to document dir immediately (06-media-pipeline). |
| `expo-image-manipulator` | SDK-57 aligned | Downscale before upload | — |
| `expo-image` | align with Expo SDK 57 — **verify at install** | Image rendering: disk-cached, downsamples to layout size — required for media thumbnails on the 2 GB device class (design-system) | Consumed through `@bolusi/ui` components; installed via `npx expo install`. |
| `@expo/vector-icons` | align with Expo SDK 57 — **verify at install** | Icon set (already in the Expo SDK dependency tree — no new native dep) | Consumed only through `@bolusi/ui`'s whitelisted `Icon` component (design-system); direct glyph imports in screens fail review. |
| `expo-file-system` | SDK-57 aligned | New `File`/`FileHandle` API (`offset` + `readBytes`) is the chunked-upload primitive | **Legacy re-exports on the main entry THROW at runtime in SDK 57** — never import `FileSystem.uploadAsync` etc. There is **NO native resumable upload**; chunked resumable upload is hand-rolled (06-media-pipeline / `api/03-media.md`). |
| `expo-location` | align with Expo SDK 57 — **verify at install** | `LocationPort` implementation in `apps/mobile` (§3.2 `@bolusi/core` row) — feeds the envelope `location` stamp | Must honor the port's non-blocking contract (§3.2): serve the best available / last-known fix (cached ≤ 60 s acceptable) and return `null` when there is none or permission is denied — never block a command waiting on a fresh GPS fix. Installed via `npx expo install`. |
| `expo-notifications` | SDK-57 aligned | Push via FCM HTTP v1 | Needs `android.googleServicesFile` + FCM service-account key uploaded to EAS; `getExpoPushTokenAsync({ projectId })`; explicit Android channel via `setNotificationChannelAsync`. Dev build required on Android. |
| `expo-background-task` + `expo-task-manager` | SDK-57 aligned | Opportunistic sync/upload retry only | 15-min floor, OS-controlled, unreliable on cheap OEM Android — **never a correctness dependency**; the foreground drain loop is the primary driver (api/01-sync §5, 06-media-pipeline). `expo-background-fetch` is deprecated — forbidden. |
| `@react-native-community/netinfo` | **12.0.1** (exact) | Connectivity signal for sync trigger (a) — "connectivity regained" (api/01-sync §5); `NetInfoPort` in `apps/mobile` | **New Architecture support starts at 11.5.0** (verified against current docs); this app is New-Arch-only (quick-crypto requires it), so ≥ 11.5.0 is mandatory and 12.0.1 is the current stable. **Autolinks — NO Expo config plugin** (the package ships no `app.plugin.js`; adding a `plugins` entry would break prebuild). `addEventListener` fires once immediately with the current state, then on change, returning an unsubscribe. RN peer `>=0.59` (RN 0.86 ✓). Task 89 pinned it (a §6 stop-and-ask, resolved). **Reconcile with `npx expo install` at native build** — unrunnable here (no Expo/device, D12/D13). |
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
| `esbuild` | **0.28.1** | Bundles the standalone Hermes vector runner for stage 6 (§5.6) — the "bundled standalone" that stage always implied. Root devDependency only | Test/CI tooling only; never a runtime dep of a shipped package. Cannot downlevel `const`/`class` below ES2015 — hence the stage-6 target (§7 record 6). Already present transitively via vite/vitest, so the exact pin dedupes. |
| `hermes-compiler` | **250829098.0.14** | The RN-0.86-pinned `hermesc`, used by stage 6 to prove the shipped toolchain compiles the vector bundle. Root devDependency (RN already depends on this exact version) | Ships **no host VM** — execution uses the pinned Hermes CLI (§7 record 6). |

### 2.6 Forbidden / cautioned packages

| Package | Status | Reason |
| ------- | ------ | ------ |
| `@hono/node-ws` | **forbidden** | Deprecated; `upgradeWebSocket` comes from `@hono/node-server` 2.x. |
| `expo-background-fetch` | **forbidden** | Deprecated; use `expo-background-task`. |
| `expo-sqlite` | not installed in v0 | Designated **swap target** behind the db-client wrapper; installing both invites duplicate-SQLite symbol conflicts. |
| `kysely-expo` | forbidden | Tracks expo-sqlite (which we don't use) in SDK lockstep; we own the op-sqlite dialect shim instead. |
| `@shopify/flash-list` | **not installed in v0** (decided task 23) | v0 lists use RN `FlatList` via the `@bolusi/ui` `List` primitive (design-system §3.13). FlashList v2 is a **native** dep and is new-architecture-ONLY (throws at runtime on old arch — verified against current docs); 08 §2.2's "check compat before adding any native dep on fresh SDK 57" applies, its declared peer range `react-native: '*'` gives no RN 0.86 signal, and its recycling win is largest on variable-height rows, which our fixed-height rows (§3.4) are not. |
| `@legendapp/list` | not installed in v0 — **pre-vetted swap target** (task 23) | 100% TypeScript, no native module, drop-in FlatList/FlashList API. The swap if the on-device list perf gate (testing-guide §4.2) fails on the 2 GB target; because lists are consumed only through the §3.13 `List` primitive, the swap is one file. |
| `nativewind`, `tamagui`, `@shopify/restyle`, `styled-components` | **forbidden** | No styling library in v0 — tokens + `StyleSheet` only (design-system §7). JS bundle weight + runtime style resolution on Hermes against the 2 GB budget. Enforced by `bolusi/boundaries`. |
| `lottie-react-native`, `moti` | **forbidden** | No animation library in v0 (design-system §7). Enforced by `bolusi/boundaries`. |
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
| `@bolusi/schemas` | Hermes + Node | Zod schemas: signed-core envelope (05 §2.1), sync DTOs (api/01-sync), auth DTOs, WS message schemas (hc's `$ws()` does NOT type socket payloads — these schemas do), and the error-envelope schema (api/00 §7). WS-message and error-envelope Zod schemas live HERE, never in `@bolusi/core` (api/00 §12.1/§14). Also owns the **shared locale vocabulary** (`Locale` / `LOCALES` / `SELECTABLE_LOCALES`, 07-i18n §1) — one home imported by both `@bolusi/core` (the setLocale enum) and `@bolusi/i18n` (the toggle), so they cannot drift (task 77). Money fields `z.number().int()` always (05 §3). Depends on `zod` only. |
| `@bolusi/i18n` | Hermes + Node | Label catalog `id`/`en` + generated key union type (mechanism owned by 07-i18n); re-exports the locale vocabulary from `@bolusi/schemas` and adds the Intl-tag map + i18next wiring. Imports `@bolusi/schemas` only (task 77) — no other internal deps. |
| `@bolusi/ui` | Hermes only | Design system: tokens (`tokens.ts`) + shared RN components (whitelisted `Icon`, PinPad, sync chips, …) — contents owned by the design-system doc. Depends on React Native, `expo-image`, `@expo/vector-icons`. **Contended shared package** (CLAUDE.md §4): changes serialize and land before dependents. |
| `@bolusi/test-support` | Node + Hermes (test-only) | Golden vector files (Ed25519 / SHA-256 / RFC 8785 — one shared fixture set), the determinism kit (mulberry32 PRNG, FakeClock, IdSource, seeded keypairs, op script generator — testing-guide §3.3), shared fakes, and the driver-conformance suite (identical statement set run against better-sqlite3 in CI and op-sqlite on device; the driver handle is injected by the runner). Never imported by shipping source. |
| `@bolusi/core` | Hermes + Node | Op append/verify (hash, chain, sign via crypto port), canonical ordering, projection engine (04 §4 head/re-fold/rebuild), command runtime (04 §5.1), sync client loop (api/01-sync §6), JCS wrapper over `canonicalize`, UUIDv7. **Platform-free**: all effects behind injected ports — `CryptoPort` (sha256, ed25519, argon2id, randomBytes), `ClockPort` (`now()` — no `Date.now()` outside the runtime stamp point), `TransportPort` (push/pull/media), `KeyStorePort`, `LocationPort` (`getBestFix(): { lat, lng, accuracyMeters } | null` — non-blocking: returns the best available fix or `null`, never waits on GPS; a cached fix up to **60 s** old is acceptable; feeds the envelope `location` stamp, 04 §5.1 / 05 §2.1), and a Kysely instance (`ProjectionDb`, 04 §2) handed in by db-client/db-server. |
| `@bolusi/modules` | manifest: Hermes + Node; screens: Hermes only | `defineModule` manifests (04 §1). **Split entry points via `package.json` `exports`:** `@bolusi/modules/notes` = platform-free manifest (operations, projections, commands, queries); `@bolusi/modules/notes/screens` = RN components. Server and harness may import only the manifest subpath; only `apps/mobile` may import `*/screens` (lint-enforced, §3.4). |
| `@bolusi/db-client` | Hermes only | The thin DB-access wrapper (**the only importer of `@op-engineering/op-sqlite`** in the repo): exports one module-singleton connection (`open({ name })` — no key; the SecureStore key drives the app-layer column cipher instead, 10-db §9.7), transaction/batch/prepared-statement surface, and the custom Kysely dialect built on `kysely-generic-sqlite` 2.0.0 **against the wrapper, not op-sqlite directly** — keeping expo-sqlite a swap target. Client schema DDL + local migrations for op-log, projection, bookkeeping tables. |
| `@bolusi/db-server` | Node only | Kysely + `PostgresDialect`, migrations (kysely-ctl; **DB migrations serialize globally** — CLAUDE.md §4), kysely-codegen output, RLS policy migrations, and **`forTenant(tenantId)` — the ONLY exported way to query tenant tables** (FR-1039). It opens a transaction, runs `set_config('app.tenant_id', $1, true)`, and yields a tenant-bound Kysely handle. The raw pool/db handle is not exported (migration runner excepted). RLS policies `USING (tenant_id = current_setting('app.tenant_id')::uuid)` are the enforcement layer; `forTenant` is ergonomics — both mandatory (D3/Q2). |
| `@bolusi/harness` | Node only | Chaos harness + N-device simulator: each simulated device = `@bolusi/core` + better-sqlite3-backed Kysely + noble crypto port + fetch transport, seeded via the `@bolusi/test-support` determinism kit + fakes; server side = `@bolusi/server` app in-process on PGlite or over HTTP to local dev server. Scenario semantics owned by the testing guide (testing-guide); this package is the machinery. Exit-criterion D4 runs here. |
| `@bolusi/server` | Node only | Hono app: sub-routers `auth`, `devices`, `users`, `tenant`, `sync`, `media`, `push`, `realtime` (endpoint map owned by api/00 §1), middleware chain per api/00-conventions, WS via `upgradeWebSocket` + SSE fallback via `streamSSE`, push sender (FCM v1 via Expo push; delivery contract owned by `api/04-push.md`). Exports `AppType` from a **types-only subpath** `@bolusi/server/client` (§4.3). |
| `@bolusi/mobile` | Hermes | Expo app: screens from `@bolusi/modules/*/screens` built on `@bolusi/ui`, `useQuery`/`useCommand` bindings, quick-crypto `CryptoPort` impl, SecureStore `KeyStorePort` impl, expo-location-backed `LocationPort` impl (§2.2), hc-typed `TransportPort` impl, sync trigger wiring (NetInfo, debounce, foreground interval, background task, pull-to-refresh — api/01-sync §5), media capture/upload driver (06-media-pipeline). |

### 3.3 Import boundary rules (dependency direction)

An edge means "may import". Anything not listed is forbidden.

| From ↓ | may import |
| ------ | ---------- |
| `schemas` | `zod` only |
| `i18n` | `schemas` (the shared locale vocabulary — 07-i18n §1; task 77), `zod` (transitively) |
| `core` | `schemas` (+ `canonicalize`, `kysely` types) |
| `ui` | `i18n` (key types only), React Native, `expo-image`, `@expo/vector-icons` |
| `modules` (manifest) | `core`, `schemas`, `i18n` (key types only) |
| `modules/*/screens` | manifest of same module, `core` (hooks types), `i18n`, `ui`, React Native |
| `db-client` | `core`, `schemas`, op-sqlite, `kysely-generic-sqlite` |
| `db-server` | `core`, `schemas`, `kysely`, `pg` |
| `apps/server` | `core`, `modules` (manifest subpaths ONLY, never `*/screens`), `schemas`, `db-server`, `i18n`, hono stack, noble |
| `apps/mobile` | `core`, `modules` (incl. screens), `schemas`, `db-client`, `i18n`, `ui`, Expo/RN stack, quick-crypto; **type-only** `@bolusi/server/client` (§4.3) |
| `test-support` | `core`, `schemas`, `kysely` (types), `db-client` (**type-only**), noble (DB drivers are injected by the runner, never imported) |
| `harness` | `core`, `modules` (manifest only), `schemas`, `test-support`, `@bolusi/server` (in-process, test-only), better-sqlite3, PGlite, noble |

Hard rules:

1. `packages/*` never import `apps/*` (sole exception: `harness` → `@bolusi/server`, test-only).
2. `db-client` and `db-server` never import each other; nothing outside them imports a DB driver.
3. `core`, `schemas`, `i18n`, `modules` manifests are **platform-free**: no `node:*`, no `react-native*`, no `expo*`, no `pg`, no `hono`, no `@op-engineering/*`, no `react-native-quick-crypto`, no `ws`.
4. The only app→app edge is `mobile` → `server` and it is **type-only** (§4.3).
5. Spec docs are not edited as an implementation side effect (CLAUDE.md §4) — same applies to this boundary table.
6. `test-support` and `harness` are **test-only**: shipping source never imports them — they appear only in test files, the harness itself, and CI entry points.
7. The `test-support` → `db-client` edge is **type-only** (ratified with task 04). The driver-conformance suite (testing-guide §2.3) must be typed against `DbDriver` — the ONE driver interface, owned by `db-client` — because re-declaring that shape in `test-support` would violate the single-implementation rule (CLAUDE.md §2.8). The driver handle itself is still injected by the runner, so rule 2 stands: `test-support` imports no DB driver. **Enforced by `bolusi/boundaries` (`dbClientTypeOnly`)**, which rejects any non-`import type` of `@bolusi/db-client` from `test-support` — the same shape as the `@bolusi/server/client` edge (§4.3). Note what does NOT enforce it, since it looks like it should: `consistent-type-imports` does not fire on a genuine value import, and `verbatimModuleSyntax` only preserves what you wrote. Residual exposure is low regardless — db-client is a `devDependency` of `test-support`, and hard rule 6 keeps `test-support` out of shipping source entirely — but the lint rule is what makes "type-only" true rather than intended.

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
| `bolusi/no-float-money` | `packages/schemas`, `packages/modules` | Money is integer IDR, floats never (05 §3). **Float-constructor prong — the whole class, not just `z.number` (task 29):** `z.number()` and `z.coerce.number()` must chain `.int()`; `z.float64()` and `z.float32()` are errors outright (a declared float format — chaining `.int()` on top is a contradiction, not a fix, and is still flagged). Sanctioned integer shapes, never flagged: `z.int()`, `z.int32()`, `z.int64()`, `z.bigint()`, `.int()` chains. `z.nan()` is out of scope — it admits only NaN, so it cannot express a money amount, and NaN is not JCS-serializable (05 §3 rejects it independently). **Real invariant + how it is made true:** the rule is syntactic and recognises a float ctor only through a **callee rooted at the zod namespace** (`z.float64()`). Zod exports every ctor as a named export too (`float64`, `number` are real tree-shakeable functions in 4.4.3), so `import { float64 } from 'zod'; float64()` would bypass it — and that bypassed the original `z.number()` prong as well. This is closed **by construction**, not by convention: the money blocks set `no-restricted-imports` to allow **only `z`** from `zod` (which also blocks `import * as zod from 'zod'`), and the rule itself resolves zod's local binding so an aliased `import { z as zod }` — which the import ban cannot catch, since the *imported* name is the permitted `z` — is still flagged. (The ban uses `no-restricted-imports` deliberately: `no-restricted-syntax` is already owned by `bolusi/no-direct-intl` across these files, and re-specifying it here would silently disable the Intl guard for schemas/modules, because flat-config rule options replace rather than merge.) **Stated limitations — the class is NOT fully closed:** a syntactic rule cannot see *output types*, so `z.int().transform((n) => n / 100)` lints clean and parses `150` → `1.5`, and `z.custom<number>()` admits `1.5`; likewise indirection (`const n = z.float64; n()`). Closing those needs type information — until then they are live holes, and money payload shapes must be reviewed, not merely linted. **Money-identifier prong:** `parseFloat`/`Number.parseFloat`/`toFixed` on identifiers matching `/(amount|price|cost|total|fee|idr)/i`. **Numeric-literal prong / schema-file convention (bootstrap):** applies to all of `packages/schemas/src/**` plus `packages/modules` files named `*.schema.ts(x)` or `schema\|schemas\|ops\|operations\|commands\|queries.ts` — module tasks MUST use these names for payload/command/query schema files; other files (e.g. screens with `opacity: 0.5`) keep only the float-constructor and money-identifier prongs. **The one carve-out:** `envelope.ts`'s `zLocation` (`lat`/`lng`/`accuracyMeters`) may use `z.float64()` — location rides in the signed **envelope**, not the payload, and 05 §3's no-floats rule is scoped to payloads (float64 is in fact stricter than `z.number()` there: it rejects NaN/Infinity, keeping values JCS-serializable). Mechanism: rule options `allowFloatFiles` **AND** `allowFloatProps` must BOTH match (conjunction, mirroring `no-op-table-update`'s `allowFiles`+`allowColumns`), wired in `tooling/eslint/src/index.js`. Default is no exemption; the same `lat: z.float64()` in a module payload schema is still an error, and a money-named prop inside `envelope.ts` is still an error. |
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

**iOS build posture (D20 §2 — the four profiles above are Android-only by *explicit decision*, not by omission).** These profiles drive `eas build`, which for v0 targets **Android only**. iOS is built and boot-verified by a *different* mechanism: the **`ios-simulator` CI job** (`.github/workflows/ci.yml` stage 14; `macos-latest`, scheduled / `workflow_dispatch`, not per-PR to control macOS minutes) runs `expo prebuild --platform ios` + an **UNSIGNED `xcodebuild`** Simulator build (`CODE_SIGNING_ALLOWED=NO` — Simulator builds need no Apple signing) and boots the app. It uses **no Apple account, no signing, and reads nothing from `eas.json`** — the lane is `xcodebuild`-driven, not `eas build`-driven. This is why `eas.json` correctly carries **no `ios` block**: an `ios` block here would only configure the **`eas build --platform ios`** (signed device / TestFlight) lane, which needs Apple Developer enrollment + an EAS account and is **owner-deferred** (D20 §2). So the file stays Android-only on purpose, and `test/eas-profiles.test.ts`'s denominator guard keeps it at exactly those four profiles. What the Simulator lane closes (compile/link, does-it-launch, generated `Info.plist`/entitlements vs tasks 83/84/87) and what stays **device-unverified** (real-device Keychain/backup, security-guide §7.4 "never resurrected") is the honest ceiling stated in D18 §5 / D20 §2 — no Simulator green is a device test.

### 5.6 CI pipeline (stage outline)

| # | Stage | Command / mechanism | Gate |
| - | ----- | ------------------- | ---- |
| 1 | install | `pnpm install --frozen-lockfile`; fail on duplicate zod in lockfile | every PR |
| 2 | lint + boundaries | `pnpm lint` | every PR |
| 3 | typecheck | `pnpm typecheck` (`tsc -b`) | every PR |
| 4 | unit | `pnpm test` | every PR |
| 5 | JCS vectors (Node) | part of stage 4 (`packages/core/test/jcs-vectors`) | every PR |
| 6 | **JCS vectors (Hermes)** | `pnpm test:jcs-hermes` (`scripts/hermes-vectors/`). Typechecks `runner.ts` under the platform-free lock (`types: []`), then esbuild bundles it standalone (imports limited to `canonicalize` + core serialization + vector data from `@bolusi/test-support`; no zod, no noble, no `node:*`); the **RN-pinned `hermesc`** (from `hermes-compiler`, the package RN 0.86 depends on) compiles it — proving the shipped toolchain accepts the bundle; then the bundle EXECUTES on Node and on a checksum-pinned **Hermes VM (CLI v0.13.0)**, and the two outputs are compared **byte-for-byte** (RFC 8785 vectors + 200 seeded envelopes). Each run also self-checks the RFC vectors on its own runtime. **Scope: JCS only — the 07-i18n §5.4 i18n vectors do NOT run here** and must not be wired in: `typeof Intl === 'undefined'` on this host VM (Intl is a Hermes build flag; RN's Android Hermes has it, this build does not), so running them here would manufacture a false failure (§7 record 6). **Version caveat — no host VM matches the pinned RN Hermes** (§7 record 6): the exact-version proof runs on device in L6 / stage 12 (task 27), as testing-guide §2.1 L7 already requires. | every PR |
| 7 | Ed25519 interop | noble sign → verify against the `@bolusi/test-support` fixture set (Node side of the quick-crypto ⇄ noble RFC 8032 interop contract) | every PR |
| 8 | server integration | `pnpm test:server` (PGlite) | every PR |
| 9 | RLS witness | `pnpm test:rls` vs dockerized `postgres:16` — includes adversarial fail-closed tests (query without `set_config` returns zero rows; cross-tenant probe returns zero rows) | merge gate |
| 10 | dual-dialect appliers | `pnpm test:appliers` | merge gate |
| 11 | chaos harness | `pnpm chaos` | merge gate |
| 12 | device lane | EAS dev-client build (fingerprint-triggered on native change) + on-device smoke: quick-crypto side of the interop vectors, argon2id timing, SQLCipher open | native change / scheduled |

**Convention (normative) — the invariant is that the `dist` a test lane imports is current before vitest starts.** `tsc -b &&` is one *mechanism* for that invariant, correct only when the `tsc -b` argument resolves to a solution file that actually builds the imported packages — and **where the script runs decides whether a bare `tsc -b` does that or silently does nothing.** Packages are consumed from `dist/` (§4); a vitest lane importing another package's `@bolusi/*` entry resolves to that package's `dist/`, with no src fallback or alias. The `unit` job (stage 4) is `needs: install` — it does NOT run `tsc -b` first and does NOT depend on the `typecheck` job. So **any test script that imports a built cross-package entry MUST build those dists first**, by the mechanism that fits its location:

- **Root script** (`package.json` at repo root): `tsc -b` resolves the root `tsconfig.json`, a solution file with **10 `references`** (§4.2, verified) that builds every workspace. A bare `tsc -b &&` is correct here — this is why the `pnpm typecheck` (`tsc -b`) and `pnpm dev` (`tsc -b --watch`) root scripts (§5.1) need no path.
- **Package-level script** (`packages/*` / `apps/*` — the shape every package `test` uses): a bare `tsc -b` resolves the script's **own** `tsconfig.json`, which is **not** a solution file — `packages/*` tsconfigs are `noEmit` with no `references` — so it typechecks that one package and **builds no dist at all. That is a silent no-op that looks exactly like compliance** (it has bitten four agents; it is the specific trap this convention exists to name). The correct mechanism is **`tsc -b ../..`** — the relative path to the root solution file (`../..` from any `packages/*` or `apps/*`) — e.g. `"test": "tsc -b ../.. && vitest run"`; equivalently, `tsc -b` pointed at the specific emitting `tsconfig.build.json`(s) of the imported packages (as `@bolusi/core`'s `test` does). **`apps/mobile` is the load-bearing example:** its tsconfig has no `references` and **cannot get any** — §4.2 forbids `composite` there (it would force emit through Expo's config) — so `references` is not the escape hatch and `tsc -b ../..` is the answer.

Do NOT instead add `unit needs: [typecheck]`: GitHub jobs run on separate runners with **no shared filesystem**, so `needs:` makes `unit` *wait* for typecheck but does not hand it that job's `dist/` — `unit` still starts cold and still must build. `needs:` is false comfort; a per-script `tsc -b` that reaches the solution file is runner-independent and incremental (a no-op only when already built). Recorded 2026-07-15 after task 03 — the first task to add cross-package `@bolusi/core` dist imports in tests — would otherwise have turned `unit` red on a cold runner (loudly broken, per testing-guide T-14c). A test that resolves a stale or absent build is a fake green; this convention is how the build graph stays honest.

**The authority is the gate, not this prose.** `scripts/check-test-script-builds.mjs` (with `packages/test-support/src/test-script-builds.test.ts`) resolves what each script's `tsc -b` *actually reaches* — following `references` transitively — and fails any test script that imports a dist-only package without building it, **including a bare `tsc -b` a grep-shaped check would pass** (task 24's trap). Its stated denominator is **10 vitest test scripts / 10 dist-only packages**; a new dist-only package or a new cross-package vitest script must appear in it. If the gate and this paragraph ever disagree, **the gate is right** — it is executable and this is prose.

Security-surface tasks additionally ship adversarial tests BEFORE review (CLAUDE.md §2.5) — the gzip-decompression middleware (malformed gzip, truncated stream, bomb), RLS probes, and signature/chain tampering all have named suites; the testing guide owns their contents.

## 6. Dev environment

### 6.1 Services

- `docker-compose.yml`: `postgres:16-alpine`, **ephemeral loopback host port**, named volume, init scripts creating `bolusi_dev` + `bolusi_rls_test` and stamping the owning compose project into each. Nothing else (no redis, no queues — out of v0 scope).
- `apps/server/.env` (gitignored, `.env.example` committed): `DATABASE_URL`, `PORT=3000`. `apps/mobile`: `EXPO_PUBLIC_API_URL` via `app.config.ts`.

**One database per worktree — never a shared one.** Compose derives its project name from the worktree directory, so each worktree gets its own container, network and volume. The host port is deliberately **not** fixed: docker assigns a free one, and `scripts/db-lane.mjs` resolves it (`docker compose port postgres 5432`) into `DATABASE_URL` for every db script. **Never hardcode 5432, and never restore a fixed `ports:` mapping.** A fixed port means only the first worktree to `db:up` binds it, every later `db:up` fails with `port is already allocated`, and — because nothing downstream noticed — its DB tests pass against a *peer's* database. That is not a hypothetical; it produced a false merge-gate green (testing-guide **T-14d**).

| Need | Command |
| ---- | ------- |
| Start this worktree's database | `pnpm db:up` (fatal on failure — the lane stops, nothing runs against a peer) |
| Its connection URL (port is ephemeral) | `pnpm db:url` → e.g. `DATABASE_URL=$(pnpm -s db:url) pnpm dev:server` |
| Remove **your own** container + volume | `pnpm db:down` |
| Claim an externally-provisioned DB (CI only) | `BOLUSI_DB_OWNER=<token> pnpm db:stamp` |

**Never `docker compose down` / `docker stop` a container that is not yours.** Peers are live agents; a container that looks abandoned may be mid-run, and killing it corrupts their work (testing-guide T-14b is that failure in a different shape). `pnpm db:down` only ever touches your own compose project. Reap your own container when you finish a task — a leaked one squatted the fixed port for 4+ hours and is what triggered T-14d.

**Attribution is asserted, not assumed.** Each dev cluster is stamped at init with the compose project that owns it (`bolusi.db_owner`, a database-level GUC, so it survives the test harness's schema reset and stays invisible to codegen and the RLS catalog sweep). The db-server test lane reads it before any test runs and **aborts** unless it matches the project it provisioned — an absent stamp counts as foreign, because an unstamped database is exactly what someone else's pre-existing container looks like. Reading is verification and writing is provisioning; the test lane only ever reads, or it would adopt the foreign database it is meant to reject.

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
2. **Expo SDK-57-aligned installs** (`npx expo install`, then normalized to exact in `apps/mobile/package.json`): `expo 57.0.4` (catalog), `react 19.2.3`, `react-native 0.86.0`, `expo-dev-client 57.0.5`, `expo-secure-store 57.0.0`, `expo-camera 57.0.1`, `expo-image-manipulator 57.0.2`, `expo-image 57.0.0`, `@expo/vector-icons 15.1.1`, `expo-file-system 57.0.0`, `expo-location 57.0.2`, `expo-notifications 57.0.3`, `expo-background-task 57.0.2`, `expo-task-manager 57.0.2`, `expo-status-bar 57.0.0`, `expo-build-properties 57.0.3` (required peer of quick-crypto's config plugin — the plugin exists as `react-native-quick-crypto/app.plugin.js` and is registered in `app.config.ts`), `@types/react 19.2.17`. **`@react-native-community/netinfo 12.0.1`** was pinned by **task 89** (sync trigger (a); §2.2 row) — registry-verified exact, New-Arch support from 11.5.0 (this app is New-Arch-only), autolinked with NO Expo config plugin; **reconcile with `npx expo install` at native build** (unrunnable here — D12/D13).
3. **`packageManager` + TypeScript** recorded in §1: `pnpm@10.34.5`, `typescript@5.9.3`.
4. **op-sqlite bundled engines** recorded in §2.2: SQLite `3.51.3`, SQLCipher `4.14.0` (read from the installed 17.1.2 package's `cpp/` sources; the podspec confirms the `package.json` `"op-sqlite"` config block drives `sqlcipher`/`performanceMode`).
5. **quick-crypto argon2 option-name smoke test** — **TODO(device)**: requires the dev-client build on hardware; not verifiable in the bootstrap environment. Owner: **task 27 (device-gates)** runs the smoke + timing on the 2 GB target (task 14 consumes the parameters per api/02-auth).
6. **Hermes-VM CI path (§5.6 stage 6)** — **RESOLVED, task 03.** Bootstrap finding confirmed: RN 0.86 depends on `hermes-compiler@250829098.0.14`, which ships `hermesc` (a COMPILER) for linux64/osx/win64 and **no host Hermes VM**.

   Task 03 established *why* no version-matched host VM exists, and what to do about it:
   - RN 0.86 pins Hermes via `sdks/.hermesversion` = **`hermes-v0.17.0`** (and `.hermesv1version` = `hermes-v250829098.0.14`). That git tag **exists in `facebook/hermes` but carries no release assets** — Facebook publishes host VM binaries only as tagged CLI releases, the newest being **v0.13.0** (2024-08-16, `hermes-cli-linux.tar.gz`). The RN-pinned VM itself ships only as Android `libhermes.so` / an iOS framework. So a host VM matching the pinned RN Hermes is obtainable **only** by building Hermes from source at the tag, or by running on an Android emulator.
   - `hermes-engine` on npm stops at 0.11.0; the npm package literally named `hermes-cli` is an unrelated project (a Brazilian travel-agency CLI) — **do not install it**.

   **Chosen mechanism** (`scripts/hermes-vectors/`, wired as the `jcs-vectors-hermes` job): compile the standalone bundle with the **RN-pinned `hermesc`** (proves the shipped toolchain accepts it), then **execute** it on Node and on the **checksum-pinned Hermes CLI v0.13.0** (`sha256 aead6eb0b8f563bb022354352eae32dad96c933330b6c1941b6db17674ca68ae`), and require byte-identical output. Verified green at task 03: 228 vector lines byte-identical on Node 22 and Hermes v0.13.0, with a negative control confirming the comparison actually detects divergence.

   **Known limitation — recorded, not papered over:** the executing VM (v0.13.0) is OLDER than the Hermes RN ships, so stage 6 proves "a real Hermes VM agrees with Node byte-for-byte", not "the exact shipped VM does". Two things close the gap: (a) the RN-pinned `hermesc` compiles the identical bundle in the same job, and (b) the **exact-version proof runs on the real device in L6 / stage 12** (task 27) — testing-guide §2.1 L7 already mandates re-running these vectors there. The Android-emulator fallback remains the option if the version skew ever needs closing *in CI*. Two v0.13.0-specific quirks are pinned in `run.mjs`: the VM needs `-Xes6-class` (undocumented but functional) since it predates default ES6-class support, and it exposes `print` but no `console`.

   **This lane is NOT a valid oracle for anything `Intl`-dependent — measured, not assumed.** On the v0.13.0 CLI, `typeof Intl === 'undefined'` (only `Number.prototype.toLocaleString` exists, ignoring its locale argument). Intl is a Hermes **build flag** (`HERMES_ENABLE_INTL`): RN's Android Hermes ships it (Android supplies ICU), this desktop CLI build does not. Consequence: the JCS vectors are safe here because RFC 8785 number→string is plain ECMAScript with no Intl involvement — but running the **task-22 i18n vectors** (`packages/i18n/test/hermes-entry.ts`, whose 07-i18n §5.4 plural/number vectors are Intl-backed) on this lane would produce a **false FAILURE** and could trigger 07-i18n §2's `@formatjs/intl-pluralrules` contingency on a bogus signal. Those vectors need an Intl-enabled Hermes — the **Android-emulator lane or L6/stage 12 (task 27)** — and are deliberately NOT wired into stage 6 here.

   **Lock 1 for the Hermes entry (task 22's request to task 03) — done.** `scripts/hermes-vectors/tsconfig.json` compiles `runner.ts` with `types: []` / `lib: ["ES2022"]`, and `pnpm test:jcs-hermes` runs it before bundling, so stage 6 is the gate. This closed a real hole: `scripts/` sits outside every workspace project, so the entry had been typechecked by *nothing*. The invariant is "runs on Hermes ⇒ platform-free" (`runner.ts` is not shipped and still runs on Hermes). The runner declares the only two host globals it uses (`print` on Hermes, `console` on Node) explicitly rather than importing platform types. The same gap still applies to task 22's `packages/i18n/test/hermes-entry.ts`, whose project sets `types: ["node"]` over `test/` — that one is unresolved and belongs with whoever wires the Intl-capable lane.
7. **`@hono/zod-validator` 0.8.0 + zod 4.4.3 co-typecheck — CONFIRMED**: `apps/server/src/app.ts` wires `zValidator` into a route and `tsc -b` is green; the lockfile resolves a single `zod@4.4.3` (enforced by `scripts/check-single-zod.mjs` in CI stage 1 + unit tests).
8. **Secret scanning**: gitleaks `8.30.1` — pre-commit hook (`.githooks/pre-commit`, installed via the root `prepare` script) + CI (unit job installs the binary sha256-pinned to `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb` for SEC-SECRET-02; `gitleaks/gitleaks-action@v2` scans history).
9. **CI stages 7–8 deferred as named placeholders**: `ed25519-interop` (stage 7 → task 03) and `server-integration` (stage 8 → task 12) exist in `.github/workflows/ci.yml` as green no-op jobs echoing their owner — same pattern as the merge-gate placeholders (stages 9–12). They become real in their owning tasks; nothing may treat the placeholder echo as coverage. **Update (task 03):** stage 7 is now real (`pnpm test:ed25519-interop` — noble reproduces every `vectors/ed25519.json` vector); stage 6 is now real (record 6). **Update (task 32): stage 8 is now real** — `server-integration` runs `pnpm test:server` (**33 files / 199 tests** as of merge `5b8dc6d`; falsified red-then-green). *(The record first said 22/162 — honestly measured in task 32's worktree, but task 13's identity suites merged underneath it before it landed, so the number was stale the moment it was quoted. Re-measured against the merged result and independently reproduced twice. This is T-14e: a number measured in a worktree is a number about that worktree, and its author structurally cannot catch the drift — only a reader at merge time can.)* Three notes from the wiring, each load-bearing:
    - **The echo was not hiding the coverage, only the gate.** The `unit` job's `pnpm test` is a bare `vitest run` with no `--project` filter, so it already sweeps all 22 `apps/server` files — the same overlap stage 5 (JCS) has with stage 4, and the reason stage 8's absence never showed up as a regression. Stage 8 restores the *named* gate the §5.6 table promises (a failure now names the server lane instead of being buried in a 95-file unit run); it does not restore lost coverage. Deleting stage 8 as "duplicate" would leave the table lying about which lanes exist.
    - **No postgres service container, by design.** Every DB-backed server test boots its own in-process PGlite (`new PGlite()` via `PGliteDialect`); the suite opens no TCP connection and reads no `DATABASE_URL` — verified by running it with `DATABASE_URL` pointed at a dead host (`postgres://…@127.0.0.1:1/blackhole`): 22/22 still passed. A service container here would idle and imply a real-PG witness this lane does not provide. Real Postgres 16 remains stage 9's job (§2.5: WASM must not be the only RLS witness).
    - **`test:server` was missing the §5.6 `tsc -b &&` prefix** and was repaired in the same task. On a cold runner (install only, no `dist/`) the bare `vitest run --project server` died with `Failed to resolve entry for package "@bolusi/schemas"` — 19 of 22 files failing. Stage 8 had never run, so nothing had ever exercised the script on a cold runner; wiring the job as originally specified ("`tsc -b` is inside the script, so the job needs only install") would have shipped a red gate for a broken *script*, not a broken suite.
    - **Update (task 36): stages 10–11 are real merge gates; stage 12 (device-lane) is now FAIL-SAFE, no longer green-for-nothing.** `dual-dialect-appliers` (stage 10 → `pnpm test:appliers`, task 11) and `chaos-harness` (stage 11 → `pnpm chaos`, task 26) run real suites and gate as §5.6 marks them (both *merge gate*). `pnpm chaos` = `tsc -b && vitest run --project harness`, the full `@bolusi/harness` catalog — measured green at **17 test files / 129 tests, EXIT=0** — and it is load-bearing, not green-for-nothing: flipping one CHAOS-01 convergence assertion (`toHaveLength(DEVICE_COUNT)` → `+ 1`) drove that scenario red (10 failed | 2 passed, EXIT=1); reverting restored green (12 passed, EXIT=0). `device-lane` (stage 12, "native change / scheduled") was the **last** echo-and-exit-0 placeholder — it wore a stage label while proving nothing, the §2.11 landmine this task exists to defuse. Task 27 (EAS + on-device) is unbuilt, so it cannot run a real suite; rather than shadow-green it now runs `node scripts/not-implemented.mjs device-lane 27-device-gates` and **exits 1** (fail-safe, EXIT=1 confirmed) — the repo's single "not implemented ⇒ exit 1" stub (§2.8), same shape as `pnpm simulate` / `pnpm db:seed`, so a red job is never mistaken for coverage. Branch protection was **unprotected (404)** at fix time, so nothing is a required check yet: this is the *preventive* close of the pre-scheduled §2.11 instance, before branch protection makes stages 10–12 required and a green echo becomes a required-check-that-proves-nothing. Delete the stub and wire the real lane in task 27. The full-workflow sweep (every job × "would it go red if its named subject broke?") lives in `ai-docs/tasks/36-merge-gates-that-pass-trivially.md`: 14 of 15 jobs run a real subject and fail on it; device-lane is the sole placeholder and it fails safe.
10. **Sanctioned deviation from §4.1 "all workspaces are `type: module`"**: `apps/mobile/package.json` intentionally omits `"type": "module"` — Metro/Expo resolve the app's own files by extension (`metro.config.cjs` is CJS; app source goes through Metro, not Node's ESM loader), and forcing ESM semantics on the app package breaks tooling expectations. The rule stands for every emitting workspace (`packages/*`, `apps/server`) and the root.

## 8. Deployment configuration (server env)

Server config is read **once at boot** through the Zod module `apps/server/src/config.ts` (security-guide §10). `apps/server/.env.example` is the **authoritative name list** — it is committed; values live only in the gitignored `.env`. Do not restate the full var list here; a duplicated list rots (T-14e). Two vars are read outside `config.ts` for stated reasons: `MEDIA_STORAGE_DIR` (`apps/server/src/media/config.ts`, read at media-router construction) and the mobile-side `EXPO_PUBLIC_API_URL` (§6.1).

### 8.1 `SYSTEM_KEY_DIR` — the system-device key store (01 §3.6, 10-db §12)

This is the "server secret store / deployment doc owns storage" that 01 §3.6 and 10-db §12 defer to. **It is this section.**

Conflict detection (01 §8.2) must sign `platform.conflict_detected` with the tenant's **system-device Ed25519 private key**. That key is deployment-owned: it never enters Postgres — only the public half lives in `devices.signing_key_public` (10-db §12). v0's store is the lowest-surprise mechanism that a multi-tenant server can key per tenant: **a directory of per-tenant key files**.

**The convention, end to end:**

1. **Provision each tenant.** `provision-tenant` (api/02-auth §2) generates the tenant's system-device keypair and, on its default path, writes the private key to a **`0600` file named exactly `system-device-<tenantId>.key`**, printing only the path (never the key). The contents are the **base64 raw Ed25519 secret key**, one line. The file is created with `wx`, so it will not overwrite an existing key — a second provisioning run cannot clobber a live tenant's key. `--key-file` chooses the path; `--print-key` sends the key to stdout **instead of** writing a file (deliberate opt-in, greppable in shell history).
2. **Collect the key files into one directory.** The default path is relative to the CWD, and the tenant id is only known *after* provisioning, so the operator moves each file into the key directory. **Do not rename them** — the store looks up exactly `system-device-<tenantId>.key`.
3. **Point `SYSTEM_KEY_DIR` at that directory.** This is the **one production injection point** (`apps/server/src/main.ts`): set ⇒ `systemKeyStoreFromConfig` builds a `DirectorySystemKeyStore`, `resolveDeps` wires `detectConflicts` over it, and **conflict detection is ACTIVE**. **Unset ⇒ no store ⇒ `detectConflicts` stays undefined and the push pipeline skips detection** — detection OFF. That is today's default and it is deliberate: pushes still succeed, nothing is detected, and the no-op is visible rather than silent.

**Enabling is server-wide, not per tenant.** `SYSTEM_KEY_DIR` is a single boolean-ish switch: once it is set, detection is wired for **every** tenant this server serves. There is no per-tenant opt-in, and a missing key file is **not** a graceful per-tenant "detection off" — see the fail-loud table below.

**Fail-loud semantics — opted-in-but-broken never silently degrades:**

| Situation | Behaviour |
| --------- | --------- |
| `SYSTEM_KEY_DIR` unset | Detection off for the whole server. Pushes succeed. The honest v0 default. |
| Key file **malformed / wrong length / not base64** | **Throws at load**, on first lookup for that tenant (the key is decoded *and* validated by deriving its public key, so a truncated secret cannot pass as "no detection"). The error names the tenant and the failure shape, **never key bytes**. |
| Key file **missing** for a tenant, dir set | The store returns `undefined`; `buildConflictDetection`'s `systemIdentity` then **throws at emission**, inside the push transaction, so the **whole push rolls back**. The pushing device sees a 500 on its first real collision. This is loud by design — a conflict that cannot be signed must not be half-recorded (10-db §3) — but it means **a tenant with no key file is broken, not degraded**. Provision a key file for every tenant before setting the var. |
| **Wrong tenant's** key in a file | Caught downstream: `appendSystemOp` self-verifies every emitted op against the tenant's system-device **public** key, so a mis-provisioned key fails at emission (rolling the push back) rather than shipping an unverifiable op to clients. |
| Directory unreadable (`EACCES`/`EISDIR`/…) | Rethrown. Only `ENOENT` means "no configured key"; every other IO error is a real misconfiguration. |
| Tenant id is not a plain UUID | No file is read (`undefined`). The traversal guard runs **before** any path is built, so no `..` or separator can escape `SYSTEM_KEY_DIR`. |

**Operational notes.** Signers are cached per tenant for the process lifetime — the system-device key is immutable (rotation = revoke + re-enroll as a new device, 01 §3.6), so **adding or changing a key file requires a server restart**. The loaded private key stays in memory inside a signer closure and is never logged.

**KMS is a future swap, not a rewrite.** The seam is the `SystemKeyStore` port (`apps/server/src/sync/conflict-wiring.ts`) — one method, `getSystemSigner(tenantId)`. Replacing the directory store with a KMS-backed one touches **only** `main.ts`; the detection pipeline never learns where keys come from. A KMS is heavier than v0 warrants; the port is what keeps that decision reversible.

*Implementation:* `apps/server/src/sync/system-key-store.ts` (`DirectorySystemKeyStore`, `systemKeyStoreFromConfig`), wired in `apps/server/src/main.ts`, injected via `apps/server/src/deps.ts`. Landed by task 78; recorded here by task 110.
