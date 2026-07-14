# TASK 07 — oplog-server: push validation pipeline, serverSeq, anomalies

**Status:** todo
**Depends on:** 02, 03, 05

## Goal

Deliver the server-side operation-acceptance pipeline as a **library layer inside `@bolusi/server`** (`apps/server/src/oplog/`) — no HTTP, no Hono; task 16 wires it to `POST /v1/sync/push`. The pipeline processes a batch in order with the exact per-op sequence from 10-db §3 (normative): dedupe by `id` → recompute `SHA-256(JCS(signedCore))` via the shared `@bolusi/core` canonicalizer and verify the Ed25519 signature against the claimed device's registered pubkey — over the verbatim JCS bytes that get stored as `signed_core_jcs`, never a jsonb reconstruction → chain continuity vs `devices.last_seq`/`last_hash` with `CHAIN_GAP` / `CHAIN_BROKEN` / batch-remainder `CHAIN_HALTED` semantics → scope validation per 05 §9 (token-device binding, tenant/store consistency, membership-not-status, device-active, and the per-type rules: `auth.device_enrolled` genesis structure, push-time permission validation of the three pin ops incl. the main_owner-target rule, `platform.conflict_detected` system-device-only / `conflict_acknowledged` member-device) → registry lookup (`UNKNOWN_TYPE`) + Zod (`SCHEMA_INVALID`). Accepted ops get a per-tenant gapless `serverSeq` via the `tenant_op_counters` row lock (locked at transaction start, incremented per accepted op only), an `operations` INSERT carrying the verbatim `signed_core_jcs`, and clock-skew flagging per 05 §6 (flag, never reject). Tamper-class rejections and skew flags write `device_anomalies` rows inside the same transaction; replay of an accepted op returns `duplicate` and consumes nothing. Also delivers `appendSystemOp` — the primitive that chains a server-built op via `system_device_chain_state`, signs its JCS core with an injected system-device signer, and allocates from the same serverSeq stream — as the seam task 17 uses for conflict emission (no conflict-detection rules in this task). Everything runs inside one `forTenant` transaction from `@bolusi/db-server`, ending with the `devices.last_seq/last_hash/last_sync_at` update.

## Docs to read

- `05-operation-log` — §3 (verbatim-bytes rule), §4 (chain), §5 (idempotency), §6 (skew formula: 48h + offline window), §8 (rejection-code registry — closed set), §9 (scope validation + the per-type extension list)
- `10-db-schema` — §2.1 (`signed_core_jcs` — why jsonb reconstruction is forbidden), §3 (serverSeq mechanism + the push-transaction shape: the normative pipeline order), §4 (`device_anomalies` DDL, `system_device_chain_state` DDL), §5 (`operations` DDL, append-only triggers/grants)
- `api/01-sync` §3 — push batch semantics, per-op result union, `CHAIN_HALTED` remainder rule
- `api/02-auth` §6.3 — server-side validation of the three privileged auth op types (roles per bundle-truth at `receivedAt`)
- `03-state-machines` §3 — what the client does with each result (the result union this pipeline emits must support it exactly)
- `security-guide` §2.1–§3 — checklist binding, test-title convention, SEC-OPLOG table
- `testing-guide` §1 (Part A test-quality rules), §3.6 CHAOS-04/05/06 definitions (this surface must be drivable in-process by the task-26 harness)

## Skills

- `superpowers:test-driven-development` — always; rejection matrix and counter allocation are test-first.
- `superpowers:verification-before-completion` — run the suites, read the output, before claiming done.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on main.

## Files / modules touched

- `apps/server/src/oplog/pipeline.ts` — `processPushBatch(deps, authedDevice, ops)` → per-op results matching the api/01 §3 union (`accepted | duplicate | rejected` + `serverSeq`/`code`/`reason`)
- `apps/server/src/oplog/steps/` — dedupe, verify-signature, chain, scope, per-type-rules, schema (order pinned by one orchestrator, not re-decided per step)
- `apps/server/src/oplog/server-seq.ts` — counter lock + per-accepted-op allocation
- `apps/server/src/oplog/skew.ts`, `apps/server/src/oplog/anomalies.ts`
- `apps/server/src/oplog/system-op.ts` — `appendSystemOp` (chain state + injected signer + same counter)
- `apps/server/test/integration/oplog/*.test.ts` — PGlite suite; concurrency subset re-runs under `pnpm test:rls` (real Postgres)
- `packages/test-support/src/oplog-fixtures/` — adversarial op builders (forged sig, resequence, splice, mutation, replay, revoked, skew) reused by tasks 03/05/15/26 — shared test-only package, coordinate but not in the contended list
- **Consumes only** — `@bolusi/schemas`, `@bolusi/core` (CONTENDED — do not modify; a gap found there is a stop-and-report, not a drive-by edit), `@bolusi/db-server` (`forTenant`, codegen types)

## Acceptance

- **Observable:** `pnpm test:server` green including the new `apps/server/test/integration/oplog/` suite (PGlite); the concurrency + append-only subset passes under `pnpm test:rls` against dockerized `postgres:16`. Pipeline is importable and runnable in-process with zero Hono/HTTP imports — enforced by a scoped `no-restricted-imports` rule on `src/oplog/**` with a fixture proving it fires.
- **Sequence & happy path:** a valid in-order batch is accepted; `serverSeq` values are dense ascending; each `operations` row's stored `signed_core_jcs` is byte-equal to the exact text that was hashed/verified (asserted, not assumed); envelope columns cross-check against the blob; `devices.last_seq/last_hash/last_sync_at` updated once at the end.
- **Rejection matrix (unit + integration, one test per code):**
  - `duplicate`: re-push of an accepted op → `duplicate`, no counter consumption, no INSERT, no anomaly row (05 §5).
  - `CHAIN_GAP`: seq N+2 after N → `CHAIN_GAP`, no anomaly row, ops before the gap in the batch unaffected.
  - `CHAIN_BROKEN` + **`CHAIN_HALTED` batch-remainder test**: first broken link → `CHAIN_BROKEN` + anomaly row; every later op in the batch → `CHAIN_HALTED` with no individual validation attempted (assert signature verify not invoked for them), no anomaly rows, zero counter consumption; ops accepted earlier in the same batch stay accepted.
  - Genesis: `seq = 1` with `previousHash ≠ 64×"0"` → `CHAIN_BROKEN`; `auth.device_enrolled` at `seq ≠ 1` or `entityId ≠ deviceId` → `SCOPE_VIOLATION`.
  - `SCOPE_VIOLATION`: op `deviceId` ≠ token device; `tenantId` ≠ device tenant; `storeId` outside tenant; `userId` not in the tenant directory. **Membership-not-status:** an op from a deactivated-but-member user is ACCEPTED (explicit test — 05 §9.3).
  - `DEVICE_REVOKED`: push from a revoked device rejects every op, no anomaly rows of tamper kinds.
  - `UNKNOWN_TYPE` and `SCHEMA_INVALID` (registry miss vs Zod fail — distinct tests).
  - Pin-op rules per api/02-auth §6.3: `auth.pin_changed` with `userId ≠ entityId` → `SCOPE_VIOLATION`; `auth.pin_reset` by an actor without `auth.user_reset_pin` → `SCOPE_VIOLATION`; `auth.pin_reset` targeting a main_owner by a non-main_owner actor → `SCOPE_VIOLATION`, by a main_owner actor → accepted; `auth.pin_lockout_cleared` without `auth.pin_unlock` → `SCOPE_VIOLATION`.
  - Conflict ops: `platform.conflict_detected` pushed from a member device → `SCOPE_VIOLATION`; `platform.conflict_acknowledged` from a member device → accepted.
- **Clock skew:** `|timestamp − receivedAt|` beyond 48h + (receivedAt − device.lastSyncAt) → accepted with `clock_skew_flagged = true` + `device_anomalies` row (`CLOCK_SKEW`); boundary case just inside the window → not flagged; no rejection path reachable from timestamp (assert code set is unreachable from the skew step).
- **Gapless serverSeq under concurrency (real-Postgres lane):** (a) two concurrent pushes for the SAME tenant serialize on the `tenant_op_counters` row lock — combined accepted ops have dense, duplicate-free `server_seq`; (b) concurrent pushes for TWO tenants do not block each other and each tenant's stream is independently gapless; (c) a batch mixing accepted/rejected/duplicate ops ends with `max(server_seq) − start == accepted count` (rejects and duplicates consume nothing).
- **Anomaly recording:** exactly `BAD_SIGNATURE`, `CHAIN_BROKEN`, `SCOPE_VIOLATION` rejections and `CLOCK_SKEW` flags write `device_anomalies` rows (correct `kind`, `device_id`, `detail` carries op id + context, NEVER the rejected op body); `CHAIN_GAP`/`CHAIN_HALTED`/`DEVICE_REVOKED`/`SCHEMA_INVALID`/`UNKNOWN_TYPE` write none.
- **`appendSystemOp`:** appends a server-built op chained from `system_device_chain_state` (`seq = last_seq + 1`, `previousHash = last_hash`, genesis rule when NULL), signed via the injected signer, `serverSeq` from the same counter inside the same transaction, chain state advanced; the produced op signature-verifies with `@bolusi/core` against the system device pubkey like any pulled op.
- **SEC tests shipped IN this task, before review (CLAUDE.md §2.5), titles embedding ids verbatim (security-guide §2.1):** `SEC-OPLOG-01` (forged sig → `BAD_SIGNATURE` + anomaly row), `SEC-OPLOG-02` (replay inert), `SEC-OPLOG-03` (resequenced chain → `CHAIN_BROKEN` + remainder `CHAIN_HALTED`; skip-ahead → `CHAIN_GAP` distinguished), `SEC-OPLOG-04` (cross-device splice → `BAD_SIGNATURE`/`SCOPE_VIOLATION`, never accepted), `SEC-OPLOG-05` (payload byte + `userId` mutation → `BAD_SIGNATURE`), `SEC-OPLOG-08` (30-day-old timestamp accepted + flagged + `CLOCK_SKEW` anomaly). The `packages/test-support` fixture builders must cover the full SEC-OPLOG-01..09 matrix so the out-of-surface owners reuse them: SEC-OPLOG-06 (Hermes JCS — task 03), SEC-OPLOG-07 (DB grants/trigger + lint fixture — task 05), SEC-OPLOG-09 (client pull-side — task 15).
- **CHAOS coverage note:** CHAOS-04, CHAOS-05, CHAOS-06 exercise this surface but live in the task-26 harness; this task's exit is that the pipeline is in-process drivable by `@bolusi/harness` (pure function of deps + batch, PGlite-compatible) — no HTTP required to run the scenarios.
- **Gates:** pipeline performs zero `UPDATE`/`DELETE` against `operations` (existing lint rule + the task-05 trigger both stay green in integration); `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:server` pass; the `test:rls` concurrency subset is wired into the merge-gate lane (08-stack §5.6 stage 9).
