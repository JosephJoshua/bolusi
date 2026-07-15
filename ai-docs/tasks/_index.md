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
| 17 | conflict-detection (server rules, system-device emission, client projection, acknowledge) | todo | 07, 08, 16, 46, 47, 48, 49 |
| 18 | media-client (capture, compress, metadata, queue, chunked upload drain) | todo | 03, 04, 22 |
| 19 | media-server (init/chunks/status/complete/download, assembly, magic bytes) | done | 05, 12 |
| 20 | realtime (WS + SSE server, client poke→pull, polling fallback) | todo | 12, 15 |
| 21 | push-notifications (token registration, Expo/FCM sender, categories, locale composition) | todo | 12, 13, 49 |
| 22 | i18n package (catalog, lint rule, ui-labels seed, Intl formatting) | done | 01 |
| 23 | ui-kit (@bolusi/ui tokens + mandatory-state components) | done | 01, 22 |
| 24 | app-shell (Expo dev-build config, navigation, auth screens, sync status screen) | done | 14, 22, 23 |
| 25 | notes-reference-module (ops v1+v2, commands, projections, queries, screens, conflicts) | todo | 11, 18, 24, 49, 50 |
| 26 | chaos-harness (@bolusi/harness + test-support, multi-device sim, CHAOS catalog, oracle) | todo | 06, 07, 08, 15, 16 |
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
| 38 | nothing tests canonical order's `seq` tie-break (deviceId IS covered by CHAOS-07ii); spec CHAOS-07 shares the blind spot (from task 35 review) | todo | 35 |
| 39 | `DB` is `any` for every consumer of @bolusi/db-server — all of apps/server untyped against the schema (from task 07) | done | 05 |
| 40 | a hanging denial-audit emit wedges execute() forever — liveness, fails closed, not a bypass (from task 10 review) | todo | 10 |
| 41 | tenant-counter lock is taken AFTER the chain-head read it should protect (comment + 10-db §3 claim otherwise); latent, UNIQUE backstops it (from task 07 review) | todo | 07 |
| 42 | @electric-sql/pglite escapes the DB-driver testOnly lock; watermark Number() comment overstates its evidence (from task 11 review) | todo | 11 |
| 43 | auth projections have NO appliers and no owner — auth.* ops are write-only; the §7/FR-1045 denial audit trail is unreadable (from task 14) | todo | 11, 14, 49 |
| 44 | `restriction_violated` denials emit NO audit op — the audit is weakest where the attack is worst; doc-first §7 ruling (from task 14 review) | todo | 14 |
| 45 | auth/core cleanups: verifyPin read-side bounds; task 10's stale DELETE comment; NUL-in-source guard; attempt-lock scope (3 sibling writes unsynchronized) (from task 14 reviews) | todo | 14 |
| 46 | **HIGH** `highestContiguousServerSeq` never advances on real Postgres — pg returns int8 as a string; every test lane uses a non-production driver (from task 16) | done | 08 |
| 47 | server watermark store has no production caller and no real-PG16 coverage — 3 gates blind to the same `Number()` (from task 16 review) | in-progress | 16 |
| 48 | **HIGH-when-17** `RawOpRow` is client-shaped 3 ways: int8 seq inverts canonical order past 9; jsonb payload throws; boolean agent_initiated always truthy (from task 46) | done | 46 |
| 49 | **HIGH** the server never applies projections — push transaction drops normative step 6; the handoff ring closes on itself; every server read model is empty (from qa orphan sweep) | todo | 16 |
| 50 | **HIGH** app bootstrap: DB open + migrations, module registration, transport, sync triggers — shell boots, data layer doesn't (from task 24) | todo | 15, 18, 24 |
| 51 | pull wire carries no per-op `serverSeq` — 10-db §9.2 says the client stores it, the wire structurally cannot carry it; client uses a local gapless counter (needs a ruling) (from task 15) | todo | 02, 15, 16 |
| 52 | 8 of 12 live invariants have no owner/test in a section titled "Invariants (testable, numbered)"; state FR ids are provenance (D15) (from QA sweep) | todo | 31 |
| 53 | `SyncStatus` declared 3× (core's is avoidable, ui's is boundary-forced); seams are `string` so the compiler finds zero (from inverse enum sweep) | todo | 15 |
| 54 | **SEC-AUTH-06/11 server push-rejection legs are unclaimed and INVISIBLE** — a "client arm" title retired the whole id; guide §162/§167 require them (from task 31) | todo | 31 |
| 55 | **HIGH — precondition for 46/48's refusals meaning anything** `test:rls` doesn't build — the only real-`pg` lane can't resolve @bolusi/core in CI and reads stale dist locally; 3rd §5.6 violation (from task 48) | in-progress | 46 |
| 56 | `readVerifier` asserts client shapes over server types — the PIN-verifier "newest" decision can invert silently; 4th instance of the class (from task 48) | todo | 48 |
| 57 | no gate stops a package re-exporting a type it doesn't emit — 0 live instances, but the class shipped `DB`-is-`any` across apps/server (from task 39 review) | todo | 39 |
| 58 | **HIGH** keystore's `THIS_DEVICE_ONLY` is an **iOS-only option** on an Android-first product; `security-guide §6.2:194` (android auto-backup exclusion) is an unchecked box **no task owns**; keystore.ts has 0 tests (from review-05 coverage sweep) | in-progress | — |
| 59 | **HIGH — needs owner decision** `api/04-push §5`'s muting model is **impossible on Android** (channel importance immutable post-creation); `applyChannelImportance` has 0 callers and would be a no-op anyway (from review-05) | todo | 21 |
| 60 | `canAttempt`: 11 tests, 0 callers, and `PinScreen.tsx:52` points at it — the lockout's coverage protects a decoy. No live bug (pinPadState gates correctly); the tests are the defect (from review-05) | todo | — |

**Status values:** `todo · in-progress · in-review · done · blocked`

**Exit (D4), revised by D12 (2026-07-15 — no physical device available):** 26 (harness green incl. every CHAOS scenario) + 25 + 27a + 28 clean.
**The D4 device clause is DEFERRED, NOT SATISFIED.** v0 "done" explicitly excludes three unproven claims, all held by blocked task 27b: argon2id p95 <300ms (so **D8's KDF parameter choice is undecided** — the default ships unvalidated and the real device may force the documented floor), op-sqlite write throughput (so **D6's whole rationale for choosing it over expo-sqlite is unvalidated** — the swap-target wrapper is load-bearing), and SQLCipher at-rest on real hardware. See `decisions/2026-07-15-no-device-v0-exit.md`. Emulator figures are regression canaries, never acceptance.
