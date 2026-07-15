# TASK 16 — sync-server (push/pull endpoints, devices sidecar, batching, gzip)

**Status:** todo
**Depends on:** 07, 12, 13

## Goal

Deliver the `sync` sub-router of `@bolusi/server`: `POST /v1/sync/push` wiring the task-07 oplog-server validation pipeline (in-order per-op processing, per-op `accepted | duplicate | rejected` results with `serverSeq`/`code`/`reason`, `CHAIN_HALTED` batch semantics, `serverTime`) and `POST /v1/sync/pull` (serverSeq cursor pagination with `hasMore`, the v0 pull-scope rule of api/01 §4.3, the devices sidecar with `devicesDirectoryVersion` full-snapshot semantics, `serverTime`). Applies the sync-route body caps to the gzip request-decompression path (1 MiB wire / 10 MiB decompressed, streaming abort-at-cap — reuse task 12's middleware if it landed generically; the sync-cap wiring and its adversarial tests land here regardless) and the 120 req/min/device rate limit across `/v1/sync/*`. Emits a scoped in-process `sync.poke` event via a publish hook (no-op default) that task 20's WS/SSE transports subscribe to. Ships the full SEC-SYNC suite plus in-process protocol fixtures for the server legs of CHAOS-01..05. Out of scope: client sync loop (15), conflict detection (17), realtime transports (20), full multi-device harness (26).

## Docs to read

- `api/01-sync.md` — §2 (device-token auth, revoked ⇒ 401, the 120/min number), §3 (push body/results/batch semantics), §4 incl. §4.1 (devices sidecar snapshot semantics) and §4.3 (pull scope rule, cursor opacity); §8 for what NOT to build here.
- `05-operation-log.md` — §8 (rejection code registry + client-behavior column), §9 (scope validation rules incl. per-type push rules — enforced by the task-07 pipeline; this task must surface its results faithfully).
- `api/00-conventions.md` — §5 (headers, §5.2 gzip request path, §5.3 sync body caps), §11 (rate limiting posture, 429 shape); plus §6–7 (envelope/status registry — HTTP errors ≠ op rejections), §8.1 (op id is the idempotency key; `Idempotency-Key` ignored on sync), §9 (`serverTime` body field vs header), §12.1 (`sync.poke` registry row — emission trigger + coalescing owner), §13 (middleware order — load-bearing).
- `security-guide.md` — §2.1–2.2 (checklist binding, denied-access semantics), §4 (sync surface checklist + SEC-SYNC-01..10).
- `testing-guide.md` — §3.1 (in-process fixture shape: production Hono fetch handler on PGlite), §3.5 (fault points), §3.6 CHAOS-01..05 (server-leg PASS criteria, CHAOS-05 T1–T9 matrix).
- `08-stack-and-repo.md` — §3.2/§3.3 (`@bolusi/server` responsibilities, import boundaries), §5.4 (`apps/server/test/integration/` PGlite + `test:rls` re-run).

## Skills

- `superpowers:test-driven-development` — always; the SEC/CHAOS tables above are the test list, write them first.
- `superpowers:verification-before-completion` — run the actual suites; paste output, not claims.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on main.

## Files / modules touched

- `apps/server/src/routes/sync.ts` — chained Hono sub-router (push + pull), mounted under `/v1/sync` (RPC inference per api/00 §14; keep `AppType` precompilation intact).
- `apps/server/src/sync/` — push orchestration over the task-07 pipeline (per-op results, CHAIN_HALTED remainder); pull query + sidecar snapshot via `forTenant` (db-server, task 05/13 tables — read-only, no migrations expected here).
- `apps/server/src/middleware/gzip-decompress.ts` — sync-route cap wiring (1 MiB/10 MiB per api/00 §5.3); create if task 12 shipped only the skeleton.
- `apps/server/src/middleware/rate-limit.ts` — per-device bucket config: 120/min across `/v1/sync/*` (interface must not assume in-memory, api/00 §11).
- `apps/server/src/realtime/poke-hub.ts` — in-process scoped publish/subscribe hook; consumed by task 20.
- `apps/server/test/integration/sync/` — all suites below.
- **Contended, expected untouched:** `@bolusi/schemas` (sync DTOs are task 02's) and `@bolusi/core`. If a DTO gap is found, stop — that is a serialized change per CLAUDE.md §4, not a drive-by edit.

## Acceptance

- **Observable done-condition:** `pnpm test:server` green including every suite below; the identical integration suite green under `pnpm test:rls` against real Postgres (08 §5.4 / CI stages 8–9). `pnpm lint` and `pnpm typecheck` (`tsc -b`) pass.

> **LOAD-BEARING CONDITION from the task-08 (projection-engine) review — the one way this design silently breaks.** The projection engine's watermark skip-safety depends on **the pull applying a batch atomically**: for a pulled batch, the op INSERTs, the projection APPLIES, and the `applied_server_seq` watermark advance MUST all commit in **one transaction**. `applied_server_seq` advances to the *highest contiguous* serverSeq PRESENT in the log (not the highest applied), so if pull ever commits per-op (insert the whole batch, then apply+commit one op at a time), the watermark durably advances past not-yet-applied ops → a rebuild or crash-recovery **silently skips** them, and the projection is permanently wrong with no error. The engine (task 08) is correct under this contract; honoring it is task 16's responsibility. **Acceptance:** the pull-apply path wraps a batch's inserts + projection applies + watermark advance in a single local transaction (cross-ref api/01 §4 atomic-batch-apply); ship a test that crashes/aborts mid-batch and asserts the watermark rolled back with the un-applied ops (no durable skip) — falsify it by committing per-op and watching a rebuild skip (§2.11).
- **Push behavior tests (concrete):**
  - Mixed batch → per-op statuses independent (one `SCOPE_VIOLATION` op does not poison siblings); `accepted` carries `serverSeq`; body carries integer-ms `serverTime`.
  - `CHAIN_BROKEN` at op k → ops k+1..n all `rejected`/`CHAIN_HALTED`; skip-ahead seq → `CHAIN_GAP` (distinguished from tamper).
  - All-rejected batch still returns HTTP `200` (api/00 §6 — HTTP errors ≠ op rejections).
  - `Idempotency-Key` header on push is ignored (no 422, no replay semantics — api/00 §8.1).
- **Pull pagination boundary tests:** cursor `0` returns from genesis; page of exactly `limit` with more remaining → `hasMore: true`, `nextCursor` = last serverSeq of page; final partial page → `hasMore: false`; cursor at head → empty `ops`, `hasMore: false`; `nextCursor` echoed verbatim resumes with no gap/overlap; `limit` > 500 rejected per schema; ops ascend by serverSeq.
- **Devices sidecar snapshot tests:** echoed version current → no `devices` field; stale/`0` → full snapshot of the pull scope incl. `kind: 'system'` device AND a revoked device with `revokedAt` (historical verifiability, api/01 §4.1); **version-bump test:** enroll/revoke between pulls bumps the tenant version and the next stale-echo pull carries the new snapshot + version; snapshot never contains other tenants' or (store-scoped) other stores' devices.
- **Rate limit tests:** 121st request within a minute across mixed push/pull → `429` `RATE_LIMITED` with `Retry-After` header + `retryAfterSeconds` detail (api/00 §7/§11); bucket is per device — a second device is unaffected.
- **Poke hook tests:** push with ≥1 `accepted` op publishes one poke scoped to the ops' pull scope (tenant + store-or-null, api/01 §4.1); all-`duplicate` or all-`rejected` push publishes none; server runs with zero subscribers (default no-op). Per-connection coalescing stays in task 20.
- **SEC-SYNC-01..10** (security-guide §4.2), titles embedding IDs verbatim, all passing — including SEC-SYNC-03 (cross-tenant op → `SCOPE_VIOLATION`, siblings unaffected), SEC-SYNC-05 (501 ops, and separately > 1 MiB gzipped, rejected before any op is processed), SEC-SYNC-07 (acknowledged-batch replay → all `duplicate`, serverSeq sequence + projections unchanged), SEC-SYNC-09 (the leak test: tenant-B ops + tenant-A store-2 ops seeded; store-1 device pulls to exhaustion → zero foreign ops, tenant-null ops present), and the gzip set SEC-SYNC-04/06/08/10 (bomb bounded with RSS-delta assertion, malformed JSON post-gzip, truncated stream, wrong encoding). SEC-SYNC-02's client-side `rejected` persistence leg lands with tasks 15/26; the server legs (401 + `DEVICE_REVOKED`) land here. These adversarial tests exist and pass BEFORE review-wave (CLAUDE.md §2.5, security-guide §2.1).
- **Security checklist copied per security-guide §2.1** — check off with evidence (file/line or test name): [ ] middleware order bearerAuth → bodyLimit(1 MiB wire) → gzip-decompress(10 MiB cap) → zValidator, never reordered; [ ] decompression streams and aborts at cap; [ ] malformed/truncated gzip → 400, no unhandled rejection; [ ] batch limits (≤500 ops, ≤1 MiB gzipped) enforced server-side; [ ] scope validation fail-closed per 05 §9, per-op results; [ ] idempotent by op-id dedupe; [ ] revoked device → 401 / `DEVICE_REVOKED`; [ ] pull scope exact per api/01 §4.3, inside `forTenant` (RLS backstop witnessed in `test:rls`); [ ] per-device rate cap on push/pull with 429; [ ] errors never echo secrets or other tenants' data; rejection `reason` strings static English.
- **CHAOS-01..05 protocol-level fixtures, in-process:** a fixture per testing-guide §3.1's server half (production `app.fetch` on PGlite, seeded tenant/stores/devices, raw wire client for tamper payloads) under `apps/server/test/integration/sync/`, running the server legs: CHAOS-01 (interleaved multi-device push arrival → server log complete, per-device seq order enforced), CHAOS-02 (F2 lost-response retry at each batch boundary → all `duplicate`, op count exact, no re-insert), CHAOS-03 (incremental pull transfers only missing ops; ≤500/batch respected), CHAOS-04 (±72 h skewed ops `accepted` + `clockSkewFlagged` via the 07 pipeline; no rejection path from skew), CHAOS-05 T1–T9 exact `results[].status`/code matrix with rejected ops absent from the log and from any other device's pull. Fixture helpers structured for reuse by task 26 (`@bolusi/harness` runs the full multi-device convergence versions there).
- **CI gates:** stages 2/3/4/8 green on PR; stage 9 (`test:rls`) green at merge; SEC-META-01 finds every SEC-SYNC id in test titles; no new lint-boundary violations (sync router imports only what 08 §3.3 allows `apps/server`).
