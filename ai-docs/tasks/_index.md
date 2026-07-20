# Task Index — canonical source of truth for "what's left"

Maintained per `CLAUDE.md` §2.6. One row per task. Update **Status** on every state change; answer "what's left" from this file.

Scope: **v0 foundation** (decisions D1; exit criteria D4). Task detail in `NN-slug.md` files alongside this index.

**Serialization notes (CLAUDE.md §4):** task 01 is globally serial (touches every package root). Tasks 02, 06, 08, 10, 11 mutate the contended `@bolusi/core` / `@bolusi/schemas` packages — they serialize with each other (their dependency chain already orders them; do not parallelize two of them even when deps allow). DB migrations (04, 05) serialize per engine but are parallel across engines.

| id | title | status | depends on |
| -- | ----- | ------ | ---------- |
| 01 | repo-scaffold (pnpm monorepo, toolchain, CI, lint rules) | done | — |
| 02 | schemas package (op envelope, API DTOs, error/WS schemas) | done | 01 |
| 03 | crypto + canonicalization (JCS, SHA-256, Ed25519 ports, RFC 8785 vectors) | done | 01, 02 |
| 04 | db-client (op-sqlite wrapper, custom Kysely dialect, SQLCipher, migrations) | done | 01 |
| 05 | db-server (PG migrations from 10-db DDL, RLS, forTenant, codegen) | done | 01 |
| 06 | oplog-client (append path: seq/chain/hash/sign, local log, bookkeeping) | done | 02, 03, 04 |
| 07 | oplog-server (validation pipeline, serverSeq, rejections, device anomalies, system-device chain) | done | 02, 03, 05 |
| 08 | projection-engine (head-apply/re-fold, watermarks, rebuild, oracle interface) | done | 04, 06 |
| 09 | permission-evaluator (scope evaluation, fail-closed, denial emission) | done | 02, 04 |
| 10 | command-runtime (execute sequence, ctx, DomainError registry, runtime emissions) | done | 06, 08, 09 |
| 11 | module-contract (defineModule, queries layer, registration) | done | 08, 10 |
| 12 | server-app (Hono skeleton, middleware chain, error envelope, RPC AppType) | done | 02, 05 |
| 13 | auth-server (control plane: login, users, verifiers, devices, bundle, provisioning, identity_audit) | done | 05, 12 |
| 14 | auth-client (enrollment, device keys, offline PIN + lockout, switcher state, idle lock, bundle persist) | done | 03, 04, 09, 10, 13 |
| 15 | sync-client (loop, triggers, backoff, SyncState, staleness, quarantine) | done | 06, 10 |
| 16 | sync-server (push/pull endpoints, devices sidecar, batching, gzip) | done | 07, 12, 13 |
| 17 | conflict-detection (server rules, system-device emission, client projection, acknowledge) | done | 07, 08, 16, 46, 47, 48, 49 |
| 18 | media-client (capture, compress, metadata, queue, chunked upload drain) | done | 03, 04, 22 |
| 19 | media-server (init/chunks/status/complete/download, assembly, magic bytes) | done | 05, 12 |
| 20 | realtime (WS + SSE server, client poke→pull, polling fallback) | done | 12, 15 |
| 21 | push-notifications (token registration, Expo/FCM sender, categories, locale composition) | done | 12, 13, 49 |
| 22 | i18n package (catalog, lint rule, ui-labels seed, Intl formatting) | done | 01 |
| 23 | ui-kit (@bolusi/ui tokens + mandatory-state components) | done | 01, 22 |
| 24 | app-shell (Expo dev-build config, navigation, auth screens, sync status screen) | done | 14, 22, 23 |
| 25 | notes-reference-module DATA LAYER (ops v1+v2, applier, commands, queries, conflict-checks, SERVER_MODULES registration, i18n catalogs) — screens carved to 96 (D17) | done | 11, 18, 24, 49, 50 |
| 26 | chaos-harness (@bolusi/harness + test-support, multi-device sim, CHAOS catalog, oracle) | in-progress | 06, 07, 08, 15, 16 |
| 27a | device-gates, EMULATOR lane (seed-200k, rebuild, execute latency; SEC-DEV-06 L6 leg on real op-sqlite; run the SEC-OPLOG-06 JCS vectors on emulator Hermes 0.17 per D13) — every figure labelled EMULATOR, never a device number | todo | 24, 25, 26, 50 |
| 27b | device-gates, PHYSICAL lane (P-1..P-6 + write benchmark; decides D8 KDF params + D6 throughput; runs the FULL SEC-OPLOG-06 JCS vectors on device Hermes 0.17 per D13) | blocked | 27a |
| 28 | security-sweep (all named SEC-* tests present + passing; cross-surface adversarial run; **owns SEC-AUTH-09** per the 2026-07-15 ruling) | todo | 13, 14, 16, 17, 19, 20, 21, 25, 26, 43, 44 |
| 29 | close the `z.float64()` bypass in `bolusi/no-float-money` (from task 02 review) | done | 02 |
| 30 | resolve 3 ui-labels keys violating the 07-i18n key grammar (from task 22) | done | 22 |
| 31 | SEC-META-01 ownership gate: mention != ownership; 3 armed rows (from task 03) | done | 03 |
| 32 | point CI `server-integration` job at `pnpm test:server` (from task 12) | done | 12 |
| 33 | reconcile task 13's server-local stopgaps to the shared packages (duplicate permission registry = §2.8 violation; auth DTOs; unregistered error codes) (from task 13) | todo | 09, 13 |
| 34 | isolate the dev Postgres per worktree (fixed 5432 = parallel worktrees silently share/corrupt one DB; unattributable greens) (from task 13 review) | done | 05 |
| 35 | convergence property test is a P1 flake: 6.6s work vs 5s default timeout (from task 13 integration) | done | 08 |
| 36 | 2 remaining CI jobs labelled *merge gate* pass trivially (stage 10 CLOSED by task 11, which caught 2 live bugs on its first real run); full workflow sweep (from task 32) | todo | 26 |
| 37 | make the store→tenant escalation guard structural, not statement order (from task 09 review) | todo | 09 |
| 38 | nothing tests canonical order's `seq` tie-break (deviceId IS covered by CHAOS-07ii); spec CHAOS-07 shares the blind spot (from task 35 review) | done | 35 |
| 39 | `DB` is `any` for every consumer of @bolusi/db-server — all of apps/server untyped against the schema (from task 07) | done | 05 |
| 40 | a hanging denial-audit emit wedges execute() forever — liveness, fails closed, not a bypass (from task 10 review) | done | 10 |
| 41 | tenant-counter lock is taken AFTER the chain-head read it should protect (comment + 10-db §3 claim otherwise); latent, UNIQUE backstops it (from task 07 review) | done | 07 |
| 42 | @electric-sql/pglite escapes the DB-driver testOnly lock; watermark Number() comment overstates its evidence (from task 11 review) | done | 11 |
| 43 | auth projections have NO appliers and no owner — auth.* ops are write-only; the §7/FR-1045 denial audit trail is unreadable (from task 14) | done | 11, 14, 49 |
| 44 | `restriction_violated` denials emit NO audit op — the audit is weakest where the attack is worst; doc-first §7 ruling (from task 14 review) | done | 14 |
| 45 | auth/core cleanups: verifyPin read-side bounds; task 10's stale DELETE comment; NUL-in-source guard; attempt-lock scope (3 sibling writes unsynchronized) (from task 14 reviews) | done | 14 |
| 46 | **HIGH** `highestContiguousServerSeq` never advances on real Postgres — pg returns int8 as a string; every test lane uses a non-production driver (from task 16) | done | 08 |
| 47 | server watermark store has no production caller and no real-PG16 coverage — 3 gates blind to the same `Number()` (from task 16 review) | done | 16 |
| 48 | **HIGH-when-17** `RawOpRow` is client-shaped 3 ways: int8 seq inverts canonical order past 9; jsonb payload throws; boolean agent_initiated always truthy (from task 46) | done | 46 |
| 49 | **HIGH** the server never applies projections — push transaction drops normative step 6; the handoff ring closes on itself; every server read model is empty (from qa orphan sweep) | done | 16 |
| 50 | **HIGH** app bootstrap: DB open + migrations, module registration, transport, sync triggers — shell boots, data layer doesn't (from task 24) | done | 15, 18, 24 |
| 51 | pull wire carries no per-op `serverSeq` — 10-db §9.2 says the client stores it, the wire structurally cannot carry it; client uses a local gapless counter (needs a ruling) (from task 15) | todo | 02, 15, 16 |
| 52 | 8 of 12 live invariants have no owner/test in a section titled "Invariants (testable, numbered)"; state FR ids are provenance (D15) (from QA sweep) | todo | 31 |
| 53 | `SyncStatus` declared 3× (core's is avoidable, ui's is boundary-forced); seams are `string` so the compiler finds zero (from inverse enum sweep) | done | 15 |
| 54 | ~~SEC-AUTH-06/11 server push-rejection legs are unclaimed~~ — **premise refuted: both legs ship in task 07 (`scope.ts:107`), falsified load-bearing. No code owed.** Needs an owner decision on who *titles* the ids (§2.1.6); sweep filed 61 (from task 31) | done | 31 |
| 55 | **HIGH — precondition for 46/48's refusals meaning anything** `test:rls` doesn't build — the only real-`pg` lane can't resolve @bolusi/core in CI and reads stale dist locally; 3rd §5.6 violation (from task 48) | done | 46 |
| 56 | `readVerifier` asserts client shapes over server types — the PIN-verifier "newest" decision can invert silently; 4th instance of the class (from task 48) | todo | 48 |
| 57 | no gate stops a package re-exporting a type it doesn't emit — 0 live instances, but the class shipped `DB`-is-`any` across apps/server (from task 39 review) | done | 39 |
| 58 | **HIGH** keystore's `THIS_DEVICE_ONLY` is an **iOS-only option** on an Android-first product; `security-guide §6.2:194` (android auto-backup exclusion) is an unchecked box **no task owns**; keystore.ts has 0 tests (from review-05 coverage sweep) | done | — |
| 59 | **HIGH — needs owner decision** `api/04-push §5`'s muting model is **impossible on Android** (channel importance immutable post-creation); `applyChannelImportance` has 0 callers and would be a no-op anyway (from review-05) | todo | 21 |
| 60 | `canAttempt`: 11 tests, 0 callers, and `PinScreen.tsx:52` points at it — the lockout's coverage protects a decoy. No live bug (pinPadState gates correctly); the tests are the defect (from review-05) | done | — |
| 61 | **HIGH — live holes, green light** SEC-DEV-04/05 client legs (offline-continue + queued-ops; outbound interception) retired by a `(server leg)` title; disclaimed in prose by `13:60-61`, **no allowlist row, no marker declares any SEC-DEV id** — 15th/16th instance of the class (from task 54's sweep) | done | 31 |
| 62 | `08 §5.6`'s normative build rule gives as its worked example the exact bare-`tsc -b` no-op that has now silently failed **4 times** (24, orchestrator, 55, 55's sweep) — spec normativises the mechanism, omits the invariant (from task 55) | done | 55 |
| 63 | `export-surface.test.ts` cites "exactly the documented set (08 §3.2)" — §3.2 documents no set, so the test is its own oracle; LOW, siblings carry the real property (from review-47) | todo | — |
| 64 | `userInterfaceStyle: 'light'` is inert — `expo-system-ui` not installed; the prebuild pipeline prints that fact every run and nobody reads prebuild stdout (from task 58 class sweep) | todo | — |
| 66 | three agents filed colliding task numbers in one session; the collision **auto-merges clean** (filenames differ) while only `_index.md` conflicts — nothing checks §2.6's source of truth against the filesystem; Status drift already live on 07/13/15/58 | done | — |
| 67 | `db-client/dialect.test.ts` "rolls back on error" times out at 5000ms under parallel load; passes in isolation — a T-10 flake, load is a hidden variable in this repo's test outcomes (from task 55 merge verification) | done | — |
| 65 | `PIN_MESSAGE_KEY`/`SWITCHER_KEY`/`REASSURANCE_KEY` label-key maps are decoys — 0 production callers, screens hardcode `t()`, only tests assert the map (same class as 60, from task 60 sweep) | done | — |
| 68 | wire the semantic export-sweep (knip) as a pinned dep + gate — `knip.json` shipped but knip is not a declared dependency, so the config is a non-executable document (from task 60) | done | — |
| 69 | **MEDIUM** no `apps/mobile` test mounts a screen — hardcoding `state="entry"` unlocks the PIN pad during every lockout with 16/16 green; the render lane EXISTS and is unused (from task 60) | in-progress | — |
| 70 | **HIGH — §6 owner decision** SEC-DEV-04's §218 ("offline-revocation caveat") contradicts api/02-auth §7.3's by-design wipe and asks for a per-op result the wire never produces (401 precedes it); 2 of 5 behaviours unbuildable, 3 shipped (from task 61, review-61 confirmed) | in-progress | — |
| 71 | ledger Status is written twice (index row + file `**Status:**`) and the merge procedure touches one — make the writeback single-action; task 66's gate is only the backstop (from task 66) | done | 66 |
| 72 | `06 §3.2` says `mediaRefSchema` lives in `@bolusi/core` — which **may not import zod** (`08 §3.3`, and core's own `strict-schema.ts:6`); the violation would compile + lint green and break only at runtime. Ruled to `@bolusi/schemas`; spec text still wrong (from task 18) | done | — |
| 73 | **HIGH — owner directive (D16)** L3 integration (378 tests) runs on PGlite, which measurably missed the int8 silent bug (14/14 green vs real `pg` 4 red) and makes RLS tests vacuous (owner bypasses RLS); move to real PG16 via testcontainers + Ryuk | done | — |
| 74 | 11 raw-`sql<T>` readers resolve their keys only because `CamelCasePlugin` is wired; nothing asserts it. `pull.ts:411` launders a missing key into a plausible serverSeq of 1; `oplog-source.ts:229` is a no-op self-alias at task 46's own fix site (from review-18) | done | — |
| 75 | `04 §3`'s registry-entry shape lists neither `conflict` (mandated by 01 §8.1, which says it "extends 04 §3") nor a way to express 01 §6's tenant-scoped op; both now ship in code — 04 is the owning doc and is stale (from task 17) | done | — |
| 76 | `user_prefs.locale DEFAULT 'id-ID'` is an **Intl tag**, not a `Locale` — the column holds `'id'\|'en'`. Inert (the applier always supplies locale) but a decoy aimed at task 21, which reads this column and whose brief already repeats the wrong value (from task 17) | todo | — |
| 77 | the selectable-locale list is declared **twice** (`i18n`'s `SELECTABLE_LOCALES`, core's `LOCALE_VALUES`) because core is pure-TS and cannot import i18n; no gate compares them — adding `zh` to one silently breaks the toggle or the payload. Decide with task 72 (same boundary shape) (from task 17) | done | — |
| 78 | **HIGH** conflict detection is built + wired into the production push route but **OFF in production**: signing `platform.conflict_detected` needs the tenant system-device key and there is NO server loader (`config.ts` reads DB+port only; provisioning writes a file nothing reads). Provide a `SystemKeyStore` (§6: key-loading mechanism is a deployment decision) (from task 17) | done | 17, 13 |
| 82 | media pipeline's MOBILE half — capture (expo-camera), signature pad, compress passes, cache→document wiring, drain triggers, background-task registration, pruning actor, remote cache. Task 18 shipped the engine and deliberately not this (the split) | todo | 18, 50 |
| 88 | `deviceId`/`storeId` are never written to `meta_kv` (10-db §9 names them; only `tenantId` has a producer) — no device is knowable as enrolled at boot (from task 50) | done | 14 |
| 89 | **HIGH** the sync loop can never start: `BundleRefreshPort` has no producer, enrollment has no caller, NetInfo unpinned — task 15's loop is correct and unconstructable (from task 50) | done | 14, 15, 50, 88 |
| 90 | the module registration list is declared twice (`SERVER_MODULES` + `CLIENT_MODULES`) with nothing checking they agree; task 25 must edit both and the compiler finds neither (from task 50) | todo | 49, 50 |
| 91 | **HIGH** iOS restore-to-new-hardware permanently BRICKS the app: restored DB + non-restored THIS_DEVICE_ONLY key → wrong-key open → `boot()` renders nothing forever, no recovery. iOS-triggered (backup asymmetry, task 84), platform-neutral fix (catch not_a_database→wipe+re-enrol). Median device event for a repair franchise (from impl-ios) | done | — |
| 92 | **HIGH** a production device cannot ENROLL: `runEnrollment`'s genesis append needs a composed `CommandRuntime` → an `OpAppendStore` with NO production producer (only test fixtures); nothing composes the runtime in `apps/mobile`. Plus the enrollment caller (`onLogin`/`onEnroll` noop; `LoginRes` lacks the `tenantName` the wizard needs). Blocks 89's production-enrollment path (from task 89) | done | 14, 50, 88, 89 |
| 93 | the db-client load-flake class (task 67) also in apps/mobile bootstrap tests + secret-scan, still on default 5000ms — same measured nondeterminism, pre-emptive (from task 67 sweep) | done | 67 |
| 94 | **MEDIUM** an enrolled device shows BLANK metadata: `index.ts` hands `Root` a hardcoded empty `deviceInfo`, so Settings renders no device name/store/tenant for a device that now enrolls (task 92); and the enroll POST sends `appVersion: ''` (expo-constants unpinned). Values all exist in `meta_kv` + the directory; wire them (from task 92) | done | 24, 92 |
| 95 | the DB-driver testOnly lock is bypassed by SUBPATH imports (`@electric-sql/pglite/worker` = real DB surface) — same gap for better-sqlite3/pg; normalize to package root (from task 42 review) | done | 42 |
| 96 | notes module SCREENS (NotesList/NoteEditor/NoteDetail) — 4 states, ConfirmSheet, optimistic save, thumbnail, i18n live-switch; carved from 25, frontend-phase (D17) | todo | 25, 24, 18 |
| 97 | CLIENT_MODULES (apps/mobile) omits authModule so auth.* ops fold as unregistered on-device — mirror of task 43 server fix, one-line + falsify (from task 43) | done | 43 |
| 98 | the SERVER arm may deny without an FR-1045 audit op — mirror of task 44, CONFIRM by producer-trace first (from task 44) | done | 13 |
| 99 | a persistently-failing denial-audit append is SILENT — the shared task-10 catch{} swallows it on every denial path (from task 44 review) | done | 10 |
| 100 | delete hand-rolled isPermissionDeniedPayload, repoint to Zod validator — a real STRENGTHENING (rejects empty permissionId + non-enum reason) + a T-15 false-comment fix (from task 45) | done | 43, 44, 45 |
| 102 | wire denialAuditTimer (systemTimer) into apps/mobile runtime so task 40 liveness bound is ACTIVE in production — currently INERT (from task 40) | done | 40 |
| 103 | @bolusi/server exports no test-auth seam so the chaos harness cannot assert HTTP-401 DEVICE_REVOKED — blocks CHAOS-05 T7 (from task 26) | done | 16 |
| 104 | ws/<subpath> escapes the platform-free PLATFORM_FORBIDDEN prong (/^ws$/ matches only bare ws) — same class as task 95, one prong over (from task 95) | done | 95 |
| 105 | wire realtime RN adapters in apps/mobile so RealtimeController runs — built-ahead + INERT today (task 24 predated 20); the 40->102 pattern (from task 20) | todo | 20, 24 |
| 106 | decide+wire the scale policy for heavy CHAOS scenarios (CHAOS-03 ~14k merge >120s/seed; CHAOS-08 nightly x4) then ship CHAOS-03 (from task 26) | in-progress | 26 |
| 107 | push channelId the server sends (conflict/device) != mobile channels (bolusi.conflict/bolusi.device) — per-category muting silently defeated; needs one id scheme + parity test (from task 21) | todo | 21, 24 |
| 108 | `platform.acknowledgeConflict` dead in the real runtime: `ctx.query(listConflictsQuery)` read seam has no `name` → throws `VALIDATION_FAILED: query has no name`; only the stubbed unit test hid it. One-line fix (self-carry `name`, mirror notes' `getNoteQuery`) + an unstubbed test (from task 26 CHAOS-07) | done | 17 |
| 109 | store/tenant NAME freshness — move name persistence into core bundle-apply so a rename refreshes it (task 94 mobile workaround goes stale) | todo | 94 |
| 110 | record the SYSTEM_KEY_DIR deployment convention (01 §3.6 defers to a deployment doc that does not exist) + fix the graceful-off contract comment (from task 78) | done | 78 |
| 111 | packages/modules is a THIRD load-flake lane (task 93 triage mis-classified it) — applier-conformance reds 3/3 at 2x load and blocks a green full pnpm test (from task 93) | done | 93 |
| 112 | wire the denial-audit diagnostics sink in apps/* so task 99 surfacing is ACTIVE (built+falsified but inert; same shape as 40->102, 20->105) | done | 99 |

| 79 | `api/03 §8`'s `MEDIA_IMMUTABLE` rule says compare own sha256 to **the server's** — no endpoint returns it (`status`/`init` carry no hash; the 409 has no `details`, and `media.ts:215` returns before the field check). Only §3.5's `ETag` exposes it. Shipped via conditional-GET `If-None-Match`, fails closed; spec text still unimplementable — 4th of the class (62/70/72) (from task 18) | done | — |
| 80 | **HIGH — owner directive (D17)** iOS is a declared platform (`app.config.ts` says so) that **nothing verifies**: `keychainAccessible` was ruled inert as Android-first and is now load-bearing+untested; SEC-DEV-08's backup guard has no iOS leg; task 59's muting analysis is Android-shaped. Audit every platform-conditional claim | done | — |
| 81 | **HIGH** — 73 moved `db-server` (15 files/124 tests) to real PG16 and left `apps/server`'s **50** files on PGlite, where the push pipeline, validation and conflict detection live. Boundary ruled by 73: consume `@bolusi/db-server/testing` (no `pg` import, no `08 §3.3` change, not a §6 red flag). Re-enable `fileParallelism` — the same change took db-server 130s → 49s (from task 73) | done | 73 |
| 83 | **HIGH — LIVE artifact defect** `app.config.ts` has no `ios` block, so the real prebuild pipeline silently synthesizes `com.placeholder.appid` as the iOS bundle identifier (`getPrebuildConfig.js:60`'s `??` fallback — T-19's shape upstream); `ios.entitlements`/`ios.infoPlist` are both null, so no iOS security control exists. Needs an owner call on the bundle id (App Store identity, unchangeable after release) (from task 80) | done | — |
| 84 | **HIGH** `security-guide §6` has no iOS row/column and never says it is Android-only; iOS's `§7.4` legs don't exist — the SQLCipher DB restores from an iCloud backup while its `THIS_DEVICE_ONLY` key does not (undecryptable DB, the mess 58 removed on Android). **Ruled: SEC-DEV-08 stays Android-scoped — its row already says "Android"; extending it would undo 58's care** (from task 80) | done | 83, 85 |
| 85 | **HIGH — owner decision** no iOS build or verification lane exists: `08 §5.5` specifies **Android APK** for all four profiles (so `eas.json` is spec-correct), all 10 CI jobs are `ubuntu-latest`, host has no Xcode. Building iOS needs cloud macOS (paid, outward-facing — §6, D12's deferred device-farm precedent) or a v0-is-Android-only ruling (from task 80) | todo | — |
| 86 | **MEDIUM — the leverage point** D17 reversed the "Android-first" premise but its `Amends:` list omits `00-product-overview.md:41`, which still states it as fact — and §3 routes every agent there first, so the next one re-derives 58's ruling. Plus: every "unverified on-device" sentence names one device, and the gaps aren't symmetric (from task 80) | todo | 85 |
| 87 | **HIGH** `expo-location` is a dependency but NOT in `app.config.ts` plugins, so its config plugin never runs: Android's generated manifest gets `ACCESS_FINE/COARSE_LOCATION` anyway via **library-manifest merging**, iOS's `infoPlist` is `null` with no `NSLocationWhenInUseUsageDescription` — and `Root.tsx:89` requests location at every boot. Apple documents termination (unverified — no iOS target exists). `expo-camera` has the identical shape for task 82 (from task 80) | done | 83, 85 |

**Status values:** `todo · in-progress · in-review · done · blocked`

**Exit (D4), revised by D12 (2026-07-15 — no physical device available):** 26 (harness green incl. every CHAOS scenario) + 25 + 27a + 28 clean.
**The D4 device clause is DEFERRED, NOT SATISFIED.** v0 "done" explicitly excludes three unproven claims, all held by blocked task 27b: argon2id p95 <300ms (so **D8's KDF parameter choice is undecided** — the default ships unvalidated and the real device may force the documented floor), op-sqlite write throughput (so **D6's whole rationale for choosing it over expo-sqlite is unvalidated** — the swap-target wrapper is load-bearing), and SQLCipher at-rest on real hardware. See `decisions/2026-07-15-no-device-v0-exit.md`. Emulator figures are regression canaries, never acceptance.
