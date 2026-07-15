# TASK 06 — oplog-client (client append path)
**Status:** in-review
**Depends on:** 02, 03, 04

## Goal
Deliver the client-side op append path in `@bolusi/core` (contended package — serializes with 02/08/10/11 per `_index.md`). It completes command op-drafts into signed cores per 05 §2.1: `id`/`entityId` via a new deterministic-testable UUIDv7 generator (08-stack §2.3 — over the injected `CryptoPort.randomBytes`, no uuid dependency), per-device `seq` and `previousHash` read from the device chain head, JCS canonicalization (task 03's wrapper) → SHA-256 `hash` → Ed25519 `signature` via `CryptoPort`, with the verbatim `signed_core_jcs` retained (10-db §2.1). It provides the atomic append+projection transaction hook for 04 §5.1 steps 4–6: one db-client transaction that allocates seq, inserts the op(s) born `syncStatus='local'`, and invokes an injected projection-apply callback — task 08 plugs the real engine into this hook. It encodes the `Operation.syncStatus` machine (03 §3) as const data in `@bolusi/core/state-machines` and exposes the single transition function the sync engine (task 15) will call over db-client's `markSyncResult` — nothing else may touch bookkeeping. It implements genesis handling: the only valid first op on a device is `auth.device_enrolled` with `seq = 1`, `previousHash` = 64 zeros, `entityId` = the device's own id (05 §2.1, §9.5). No sync loop, no server validation, no projection appliers — those are tasks 15, 07, 08.

## Docs to read
- `05-operation-log.md` — all sections (envelope §2, canonicalization §3, chain §4, idempotency §5, rejection codes §8, genesis rule §9.5, retention §10).
- `03-state-machines.md` — §3 (Operation.syncStatus: birth states, transitions, terminals, invalids) and §1 (single-implementation rule, shared executor, code↔doc parity test, `INVALID_TRANSITION` behavior).
- `04-module-contract.md` — §5.1 steps 4–6 only (draft completion inputs, atomic append+apply, debounced sync scheduling is out of scope; note the five sanctioned runtime emissions incl. `auth.device_enrolled`).
- `10-db-schema.md` — §9.2 (client operations DDL, bookkeeping columns, indexes, the `markSyncResult`-only mutation rule) and §2.1 (`signed_core_jcs` verbatim-bytes rationale).
- `security-guide.md` — §3.1 checklist rows that bind the client: non-JSON values rejected before canonicalization; no client mutation path; rejected ops kept and surfaced. §3.2 for the SEC-OPLOG ids scoped below.

## Skills
- `superpowers:test-driven-development` — always.
- `superpowers:verification-before-completion` — run the named suites and read their output before claiming done.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on main.

## Files / modules touched
- `packages/core/src/oplog/` — **contended (`@bolusi/core`)**: `draft.ts` (draft → completed signed core: field completion, non-JSON guard, JCS/hash/sign, absent-vs-null enforcement), `chain.ts` (device chain-head read: max `seq` + its `hash`; genesis rules), `append.ts` (atomic append + projection-apply hook, duplicate-id no-op), `bookkeeping.ts` (syncStatus transition layer over db-client's `markSyncResult`), `verify.ts` (recompute-hash + verify-signature helper used by tamper tests, and later by pull-side/task 15).
- `packages/core/src/state-machines/op-sync-status.ts` — **contended**: 03 §3 table as const data + executor entry (create `state-machines/` executor here if tasks 02–04 have not).
- `packages/core/src/ids/uuidv7.ts` — UUIDv7 over injected rng/clock (08-stack §2.3); lowercase canonical text (10-db §2).
- `packages/core/src/index.ts` — exports.
- `packages/core/test/oplog/*.test.ts`, `packages/core/test/oplog/fixtures/tamper/*` — tests + committed tamper fixture set (reused later by task 07 / CHAOS-05).
- `tooling/eslint/` — register `packages/core/src/oplog/bookkeeping.ts` (exact file) in the `bolusi/no-op-table-update` allowlist (08-stack §5.2). No other lint changes.
- Consumes, does not modify: `@bolusi/schemas` envelope schema (task 02), `CryptoPort`/JCS wrapper (task 03), db-client transaction surface + `markSyncResult` (task 04).

## Acceptance
Observable done-condition: `pnpm typecheck`, `pnpm lint`, `pnpm test` green with all suites below present; `@bolusi/core` still compiles platform-free (`types: []`, no new deps beyond §3.3 matrix).

Tests to add (concrete):
- **Chain-continuity property test**: with injected FakeClock/rng/keys, append N ops (N property-varied, ≥ 200 in one case; include a mid-chain `userId` change — chain spans users, 05 §4) → assert seq is exactly 1..N with no gaps; `previousHash[i] === hash[i−1]`; genesis `previousHash` = 64 zeros; every `hash === SHA-256(JCS(core))` recomputed independently; every signature verifies against the device pubkey; every stored `signed_core_jcs` is a JCS fixpoint (`parse ∘ canonicalize` returns identical bytes, 10-db §2.1).
- **Tamper detection fixtures** (committed under `test/oplog/fixtures/tamper/`): mutate one payload byte → recomputed hash ≠ stored hash; mutate a non-payload core field (`userId`) → same; mutate `previousHash` → chain-verify fails; swap two ops' `seq` → chain-verify fails. `verify.ts` detects all four. Titles embed `SEC-OPLOG-05` verbatim (client leg: fixture set + local detection; the server rejection leg ships in task 07 reusing these fixtures).
- **Duplicate-id no-op** (`SEC-OPLOG-02` client leg): appending/applying an op whose `id` already exists locally is a no-op — op row unchanged, projection-apply callback invoked 0 times (spy), chain head unchanged (05 §5). Server leg lands in task 07.
- **Bookkeeping state machine**: birth = `local` atomic with append; every valid 03 §3 transition — `local→synced` on `accepted` and on `duplicate` (both set `syncedAt`), `local→rejected` for each 05 §8 code with `rejectionCode`+`rejectionReason` set atomically in the same statement; `CHAIN_GAP` = no transition, op stays `local`; repeated `accepted`/`duplicate` on an already-`synced` op = idempotent no-op (not a transition). Invalid: `synced→rejected`, `rejected→synced`, `*→local` each throw `DomainError('INVALID_TRANSITION', {machine, from, event})`. Rejected ops are never deleted (row still present, terminal). Note: setting `SyncState.pushHalted` on `CHAIN_BROKEN` is task 15's side effect, not this layer's — assert this layer only marks the op.
- **Parity test** (03 §1): the const table in `op-sync-status.ts` equals 03 §3's doc table (values, transitions, terminals); drift fails CI.
- **Genesis-op shape test**: first append on an empty chain succeeds only as `auth.device_enrolled` with `seq = 1`, `previousHash` = `'0'.repeat(64)`, `entityId` = deviceId (05 §9.5); any other first op → typed error, nothing inserted; a second `auth.device_enrolled` on a non-empty chain → typed error.
- **Non-JSON guard** (security-guide §3.1): `undefined`, `NaN`, `Infinity`, `BigInt`, function, non-plain object anywhere in the signed core → typed error *before* canonicalization; nullable core fields are always present-and-`null`, never absent (05 §3) — assert on the produced JCS bytes.
- **Atomicity**: projection-apply callback throws → transaction rolls back: no op row, chain head unchanged; retry with same draft succeeds with the same seq.
- **UUIDv7 unit tests**: version/variant bits, 48-bit ms timestamp from injected clock, lowercase text, monotonic ordering for same-ms ids via injected rng; deterministic given seeded rng+FakeClock.

SEC-*/CHAOS-* scoping (explicit): this task ships the client legs of **SEC-OPLOG-02** (duplicate inert, no projection double-apply) and **SEC-OPLOG-05** (tamper fixture set + local detection), titled with the ids verbatim (security-guide §2.1). **SEC-OPLOG-01/03/04/07/08** (server validation, DB-level mutation denial) belong to tasks 05/07; **SEC-OPLOG-06** (JCS Hermes vectors) to task 03; **SEC-OPLOG-09** to task 15. **CHAOS-05** (tamper matrix) and **CHAOS-06** (duplicate replay/backup-restore) run end-to-end in task 26 — this task must leave them buildable: raw chain-state access for constructing tampered batches, fully injected clock/rng/id/crypto (no `Date.now()`, no ambient randomness), and the duplicate-id no-op above.

Lint/CI gates:
- `bolusi/no-op-table-update` allowlist updated to exactly the new bookkeeping module; a lint fixture proves an `updateTable('operations')` touching signed-core columns from any other core file still fails.
- No `Date.now()`/`Math.random()` in `packages/core/src/oplog/**` (clock/rng only via ports) — enforced by review + existing lint config.
- Core unit tests run under `pnpm test` (CI stages 3–4); no Hermes/device lane changes in this task.
