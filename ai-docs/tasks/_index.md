# Task Index — canonical source of truth for "what's left"

Maintained per `CLAUDE.md` §2.6. One row per task. Update **Status** on every state change; answer "what's left" from this file.

Scope: **v0 foundation** (decisions D1; exit criteria D4). Task detail in `NN-slug.md` files alongside this index.

**Serialization notes (CLAUDE.md §4):** task 01 is globally serial (touches every package root). Tasks 02, 06, 08, 10, 11 mutate the contended `@bolusi/core` / `@bolusi/schemas` packages — they serialize with each other (their dependency chain already orders them; do not parallelize two of them even when deps allow). DB migrations (04, 05) serialize per engine but are parallel across engines.

| id | title | status | depends on |
| -- | ----- | ------ | ---------- |
| 01 | repo-scaffold (pnpm monorepo, toolchain, CI, lint rules) | done | — |
| 02 | schemas package (op envelope, API DTOs, error/WS schemas) | done | 01 |
| 03 | crypto + canonicalization (JCS, SHA-256, Ed25519 ports, RFC 8785 vectors) | in-progress | 01, 02 |
| 04 | db-client (op-sqlite wrapper, custom Kysely dialect, SQLCipher, migrations) | in-review | 01 |
| 05 | db-server (PG migrations from 10-db DDL, RLS, forTenant, codegen) | in-progress | 01 |
| 06 | oplog-client (append path: seq/chain/hash/sign, local log, bookkeeping) | todo | 02, 03, 04 |
| 07 | oplog-server (validation pipeline, serverSeq, rejections, device anomalies, system-device chain) | todo | 02, 03, 05 |
| 08 | projection-engine (head-apply/re-fold, watermarks, rebuild, oracle interface) | todo | 04, 06 |
| 09 | permission-evaluator (scope evaluation, fail-closed, denial emission) | todo | 02, 04 |
| 10 | command-runtime (execute sequence, ctx, DomainError registry, runtime emissions) | todo | 06, 08, 09 |
| 11 | module-contract (defineModule, queries layer, registration) | todo | 08, 10 |
| 12 | server-app (Hono skeleton, middleware chain, error envelope, RPC AppType) | todo | 02, 05 |
| 13 | auth-server (control plane: login, users, verifiers, devices, bundle, provisioning, identity_audit) | todo | 05, 12 |
| 14 | auth-client (enrollment, device keys, offline PIN + lockout, switcher state, idle lock, bundle persist) | todo | 03, 04, 09, 13 |
| 15 | sync-client (loop, triggers, backoff, SyncState, staleness, quarantine) | todo | 06, 10 |
| 16 | sync-server (push/pull endpoints, devices sidecar, batching, gzip) | todo | 07, 12, 13 |
| 17 | conflict-detection (server rules, system-device emission, client projection, acknowledge) | todo | 07, 08, 16 |
| 18 | media-client (capture, compress, metadata, queue, chunked upload drain) | todo | 03, 04, 22 |
| 19 | media-server (init/chunks/status/complete/download, assembly, magic bytes) | todo | 05, 12 |
| 20 | realtime (WS + SSE server, client poke→pull, polling fallback) | todo | 12, 15 |
| 21 | push-notifications (token registration, Expo/FCM sender, categories, locale composition) | todo | 12, 13 |
| 22 | i18n package (catalog, lint rule, ui-labels seed, Intl formatting) | done | 01 |
| 23 | ui-kit (@bolusi/ui tokens + mandatory-state components) | in-progress | 01, 22 |
| 24 | app-shell (Expo dev-build config, navigation, auth screens, sync status screen) | todo | 14, 22, 23 |
| 25 | notes-reference-module (ops v1+v2, commands, projections, queries, screens, conflicts) | todo | 11, 18, 24 |
| 26 | chaos-harness (@bolusi/harness + test-support, multi-device sim, CHAOS catalog, oracle) | todo | 06, 07, 08, 15, 16 |
| 27 | device-gates (on-device perf: seed-200k cold start, rebuild, KDF + write benchmarks) | todo | 24, 25, 26 |
| 28 | security-sweep (all named SEC-* tests present + passing; cross-surface adversarial run) | todo | 13, 14, 16, 17, 19, 20, 21, 25, 26 |
| 29 | close the `z.float64()` bypass in `bolusi/no-float-money` (from task 02 review) | todo | 02 |
| 30 | resolve 3 ui-labels keys violating the 07-i18n key grammar (from task 22) | todo | 22 |

**Status values:** `todo · in-progress · in-review · done · blocked`

**Exit (D4):** 26 (harness green incl. every CHAOS scenario) + 25 on a physical 2GB Android via 27, plus 28 clean.
