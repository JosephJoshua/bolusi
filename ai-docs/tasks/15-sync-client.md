# TASK 15 — sync-client (loop, triggers, backoff, SyncState, staleness, quarantine)

**Status:** todo
**Depends on:** 06, 10

## Goal

Deliver the client sync loop in `@bolusi/core` exactly per api/01-sync §5–7 and the 03-state-machines §10 machine: a single-flight, trigger-coalescing `requestSync(reason)` entry point (reasons: connectivity / debounced-append / periodic / bg-task / manual — platform event wiring lands in task 24; this task ships the intake + coalescing + rerun flag), push of all `syncStatus=local` ops in ascending-seq batches via the injected `TransportPort`, pull-until-drained with atomic batch apply (ops + projections in one local transaction, cursor persisted after), the devices-sidecar apply and quarantine flow of api/01 §4.1–4.2 (verify every pulled op, unknown-key refetch-once with `devicesDirectoryVersion: 0`, `quarantined_ops` insert, cursor advance past bad ops, re-verify on every sidecar update), a once-per-loop injected bundle-refresh step (implementation from task 14; 304 = steady-state success), and the 5 s → 15 s → 60 s → 5 min backoff with absorb/early-exit semantics. Maintains every `SyncState` field of 01-domain-model §5.2 including `pushHalted` (set on `CHAIN_BROKEN`; push skipped, pull continues) and `syncDisabled`/`syncDisabledReason` (set on `DEVICE_REVOKED` 401), recomputes derived pending counts (never stored), exports the staleness constants + level computation of 03 §8 (server-relative, drift-safe), and surfaces every op-level rejection per 03 §3 / 05 §8 — never silent, never a loop failure. Platform-free: all effects behind `ClockPort`/`TransportPort`/injected Kysely; no timers or `Date.now()` outside ports.

## Docs to read

- `api/01-sync.md` — ALL sections (§1–§8; §3–§6 are the normative loop, §4.1–4.2 the sidecar/quarantine contract, §7 staleness consumer contract).
- `03-state-machines.md` — §10 (sync-loop machine: full transition table, backoff, guards), §8 (staleness levels + the constants this task must export), §3 (per-op `syncStatus` transitions the push phase drives, incl. `CHAIN_GAP`/`CHAIN_HALTED`/repeated-ack rules).
- `05-operation-log.md` — §8 (rejection-code registry + mandated client behavior per code).
- `01-domain-model.md` — §5.2 (SyncState field list + derived `pendingOperationCount`/`pendingMediaCount` formulas).
- `10-db-schema.md` — §9.3 (`sync_state` DDL), §9.5 (`device_registry`, `quarantined_ops` DDL).

> **Trap flagged by task 02's review — read before writing the pull phase.** `zPullResponse` (`@bolusi/schemas`) is tolerant at the top level but its `ops: z.array(zSignedOperation)` is **strict** (correct — you cannot strip unknown keys out of a hashed structure). Consequence: one odd op fails the WHOLE batch parse, which would violate api/01 §4.2's "one bad op must not brick sync". **Parse the envelope and each op individually; never validate the batch through `zPullResponse` and treat a throw as a transport failure.** A per-op parse failure is a quarantine case, not a loop failure.
- `08-stack-and-repo.md` — §3.2 `@bolusi/core` row (ports), §3.3–3.4 (import boundaries, platform-freeness locks), §5.4 (Vitest layout).
- `security-guide.md` — SEC-OPLOG-09 row only.
- `testing-guide.md` — §3.5 (fault points F1–F5), CHAOS-02 and CHAOS-12 entries (the end-to-end scenarios this surface must later satisfy in task 26; their semantics define this task's unit fixtures).

## Skills

- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.
- `superpowers:test-driven-development` — always.
- `superpowers:verification-before-completion` — run the suite, read the output, before claiming done.
- `superpowers:systematic-debugging` — on any red.

## Files / modules touched

- `packages/core/src/sync/` — loop + machine (`loop.ts`), trigger intake/coalescing, push phase, pull phase + atomic apply, sidecar apply, quarantine (`quarantine.ts`), backoff, `SyncState` persistence, staleness (`staleness.ts` exporting `STALENESS_WARNING_MS`, `STALENESS_STALE_MS`, level fn), public exports. **`@bolusi/core` is contended (CLAUDE.md §4 / _index serialization note) — serialize with tasks 02/06/08/10/11; do not run in parallel with them.**
- `packages/core/src/ports/` — extend `TransportPort` with typed push/pull (+ bundle-refresh hook signature) if task 06/10 left them unspecified; port shapes per 08 §3.2.
- `packages/core/test/sync/*.test.ts` — everything under Acceptance.
- `packages/db-client/src/migrations/` — ONLY if task 04 did not ship `sync_state` (10-db §9.3) or `quarantined_ops`/`device_registry` (10-db §9.5); verify first, don't duplicate.
- No `apps/*` changes: NetInfo/debounce/interval/background-task/pull-to-refresh wiring is task 24; server endpoints are task 16.

## Acceptance

Observable done-condition: `pnpm --filter @bolusi/core test` green with all tests below present; `pnpm lint` and `pnpm typecheck` green (platform-free locks intact). All tests use injected fakes (FakeClock, fake transport, better-sqlite3 Kysely via test-support) — no sockets, no real timers.

Loop machine (03 §10):

- Every valid transition row of the §10 table exercised: `idle→pushing` (each trigger reason), `pushing→pulling` (drained / nothing-to-push / halted-mid-push), `pushing→backoff`, `pulling→idle` (drain complete: `lastSuccessfulSyncAt` set, `failureCount` reset, staleness + derived counts recomputed, rerun flag honored with immediate re-entry), `pulling→backoff` (cursor progress kept), `backoff→pushing` (timer / manual / connectivity), any→idle on 401 `DEVICE_REVOKED`.
- Invalid transitions rejected per §10: dev crash / prod log-and-unchanged behavior asserted.
- Trigger guard: `syncDisabled=true` ⇒ no cycle starts; `pushHalted=true` ⇒ push phase skipped, pull runs and drains.
- Single-flight concurrency test: N concurrent triggers while `pushing`/`pulling` ⇒ exactly one loop instance ran (transport-call accounting), rerun flag causes exactly one follow-up cycle, not N.

Push phase (api/01 §3, 03 §3):

- Batching: >500 local ops split into ascending-seq batches of ≤500; per-op result marking — `accepted`/`duplicate` ⇒ `synced`+`syncedAt`; `rejected` ⇒ `rejected` with `rejectionCode`/`rejectionReason` set atomically and surfaced (assert the surfacing emission for EVERY code in 05 §8 — no silent path); `CHAIN_GAP` ⇒ stays `local`, re-push from N+1.
- Interrupted-push resume: transport failure mid-request ⇒ backoff ⇒ same batch retried; `duplicate` acks for already-`synced` ops are idempotent no-ops (no `INVALID_TRANSITION`), matching CHAOS-02 F1/F2/F3 semantics at unit scale.
- `pushHalted`: `CHAIN_BROKEN` ⇒ op `rejected`, `pushHalted=true`, surfaced loudly; batch remainder `CHAIN_HALTED` marked `rejected` WITHOUT re-setting the flag; next cycle skips push and pull still continues/drains. Op-level rejections do NOT increment `failureCount` or enter backoff.

Pull phase (api/01 §4):

- Pull-until-drained loops while `hasMore`; cursor persisted only after the atomic apply (ops inserted + projections updated in one transaction).
- Interrupted-pull idempotence: simulated crash after apply-commit but before cursor persist (F4) ⇒ re-pull of the same batch is a byte-identical no-op (projection digest unchanged); crash mid-transaction (F5) ⇒ rollback, re-pull re-applies cleanly.
- Devices sidecar: differing `devicesDirectoryVersion` ⇒ `device_registry` replaced atomically (revoked devices retained), new version stored in `SyncState`; device state never read from ops.
- Quarantine fixtures — **SEC-OPLOG-09 (client half)**, titles embedding the ID verbatim: (a) verified-bad signature ⇒ row in `quarantined_ops`, NOT applied to projections, cursor advances past it, surfaced with label key `sync.quarantine.*`; (b) unknown pubkey ⇒ exactly ONE re-pull with `devicesDirectoryVersion: 0`, still unknown ⇒ quarantined; (c) later sidecar delivering the missing key ⇒ quarantined op re-verified, applied via the engine's out-of-order path, removed from `quarantined_ops`, while the bad-signature op stays quarantined; (d) subsequent valid pulls keep working throughout. (These are the in-task unit half of CHAOS-12; the full harness scenario lands in task 26.)

Backoff, SyncState, staleness:

- Backoff schedule under FakeClock: 5 s → 15 s → 60 s → 5 min cap, reset on success; automatic triggers during backoff absorbed (timer unchanged); manual trigger and connectivity-regained cancel the timer.
- `DEVICE_REVOKED` 401: `syncDisabled=true` + `syncDisabledReason='device_revoked'`, loop to `idle`, no further automatic cycles.
- `lastSuccessfulSyncAt` set ONLY on error-free pull drain (failed push never touches it); `lastServerTime`/`lastServerTimeReceivedAt`, `lastPushAt`/`lastPullAt`, `lastSyncError`, `backoffUntil` maintained per 01 §5.2; pending counts asserted as derived queries (no stored column written).
- Staleness threshold transitions: exact-boundary tests at 1 h and 24 h using the EXPORTED constants (no numeric literals in tests), `fresh↔warning↔stale` both directions, never-synced ⇒ `stale`; drift test — device clock skewed forward/back must not change the level (baseline = `lastServerTime` + elapsed, per api/01 §7).
- Bundle-refresh hook: invoked exactly once per cycle, 304 treated as success; loop never throws to callers on any failure path (every failure speaks through `SyncState`).

CHAOS mapping (harness scenarios exercising this surface end-to-end in task 26 — this task must not make them impossible): CHAOS-02, CHAOS-12, plus the client halves of CHAOS-03, CHAOS-05 (T3/T5/T7 client behavior), CHAOS-06(b)(c). Only SEC-OPLOG-09 is owed by THIS surface; SEC-SYNC-01..10 are server-side (task 16).

Gates: `@bolusi/eslint-config` boundary rules pass unchanged (`core` imports only `schemas` + type-only kysely; no `node:*`/RN/expo/timers); `"types": []`/ES2022 tsconfig lock compiles; no `Date.now()`/`setTimeout` outside injected ports (add a lint assertion or grep-check in CI if not already enforced); Conventional Commit subjects only; pre-commit hooks pass without `--no-verify`.
