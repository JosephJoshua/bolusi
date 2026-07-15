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
| 07 | oplog-server (validation pipeline, serverSeq, rejections, device anomalies, system-device chain) | in-progress | 02, 03, 05 |
| 08 | projection-engine (head-apply/re-fold, watermarks, rebuild, oracle interface) | done | 04, 06 |
| 09 | permission-evaluator (scope evaluation, fail-closed, denial emission) | in-progress | 02, 04 |
| 10 | command-runtime (execute sequence, ctx, DomainError registry, runtime emissions) | todo | 06, 08, 09 |
| 11 | module-contract (defineModule, queries layer, registration) | todo | 08, 10 |
| 12 | server-app (Hono skeleton, middleware chain, error envelope, RPC AppType) | done | 02, 05 |
| 13 | auth-server (control plane: login, users, verifiers, devices, bundle, provisioning, identity_audit) | in-progress | 05, 12 |
| 14 | auth-client (enrollment, device keys, offline PIN + lockout, switcher state, idle lock, bundle persist) | todo | 03, 04, 09, 13 |
| 15 | sync-client (loop, triggers, backoff, SyncState, staleness, quarantine) | todo | 06, 10 |
| 16 | sync-server (push/pull endpoints, devices sidecar, batching, gzip) | todo | 07, 12, 13 |
| 17 | conflict-detection (server rules, system-device emission, client projection, acknowledge) | todo | 07, 08, 16 |
| 18 | media-client (capture, compress, metadata, queue, chunked upload drain) | todo | 03, 04, 22 |
| 19 | media-server (init/chunks/status/complete/download, assembly, magic bytes) | done | 05, 12 |
| 20 | realtime (WS + SSE server, client poke→pull, polling fallback) | todo | 12, 15 |
| 21 | push-notifications (token registration, Expo/FCM sender, categories, locale composition) | todo | 12, 13 |
| 22 | i18n package (catalog, lint rule, ui-labels seed, Intl formatting) | done | 01 |
| 23 | ui-kit (@bolusi/ui tokens + mandatory-state components) | done | 01, 22 |
| 24 | app-shell (Expo dev-build config, navigation, auth screens, sync status screen) | todo | 14, 22, 23 |
| 25 | notes-reference-module (ops v1+v2, commands, projections, queries, screens, conflicts) | todo | 11, 18, 24 |
| 26 | chaos-harness (@bolusi/harness + test-support, multi-device sim, CHAOS catalog, oracle) | todo | 06, 07, 08, 15, 16 |
| 27a | device-gates, EMULATOR lane (seed-200k, rebuild, execute latency; SEC-DEV-06 L6 leg on real op-sqlite; run the SEC-OPLOG-06 JCS vectors on emulator Hermes 0.17 per D13) — every figure labelled EMULATOR, never a device number | todo | 24, 25, 26 |
| 27b | device-gates, PHYSICAL lane (P-1..P-6 + write benchmark; decides D8 KDF params + D6 throughput; runs the FULL SEC-OPLOG-06 JCS vectors on device Hermes 0.17 per D13) | blocked | 27a |
| 28 | security-sweep (all named SEC-* tests present + passing; cross-surface adversarial run) | todo | 13, 14, 16, 17, 19, 20, 21, 25, 26 |
| 29 | close the `z.float64()` bypass in `bolusi/no-float-money` (from task 02 review) | in-progress | 02 |
| 30 | resolve 3 ui-labels keys violating the 07-i18n key grammar (from task 22) | in-progress | 22 |
| 31 | SEC-META-01 ownership gate: mention != ownership; 3 armed rows (from task 03) | todo | 03 |
| 32 | point CI `server-integration` job at `pnpm test:server` (from task 12) | in-progress | 12 |
| 33 | reconcile task 13's server-local stopgaps to the shared packages (duplicate permission registry = §2.8 violation; auth DTOs; unregistered error codes) (from task 13) | todo | 09, 13 |

**Status values:** `todo · in-progress · in-review · done · blocked`

**Exit (D4), revised by D12 (2026-07-15 — no physical device available):** 26 (harness green incl. every CHAOS scenario) + 25 + 27a + 28 clean.
**The D4 device clause is DEFERRED, NOT SATISFIED.** v0 "done" explicitly excludes three unproven claims, all held by blocked task 27b: argon2id p95 <300ms (so **D8's KDF parameter choice is undecided** — the default ships unvalidated and the real device may force the documented floor), op-sqlite write throughput (so **D6's whole rationale for choosing it over expo-sqlite is unvalidated** — the swap-target wrapper is load-bearing), and SQLCipher at-rest on real hardware. See `decisions/2026-07-15-no-device-v0-exit.md`. Emulator figures are regression canaries, never acceptance.
