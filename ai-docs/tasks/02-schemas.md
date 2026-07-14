# TASK 02 — schemas package (op envelope, API DTOs, error/WS schemas)

**Status:** todo
**Depends on:** 01

## Goal

Deliver `@bolusi/schemas` (`packages/schemas`) complete for v0: the Zod definitions every other package validates against, and nothing else (no crypto, no I/O, `zod`-only imports). Ships: the signed-core envelope exactly per 05 §2.1–2.2 (`.strict()`, absent-vs-null nullable fields, integer-money / payload-number guard helpers), client and server bookkeeping types (05 §2.3–2.4), sync push/pull DTOs (api/01 §3–4, incl. the `DeviceInfo` devices sidecar and the pulled-`SignedOperation` shape the client quarantine path verifies against), the error envelope + the full HTTP error-code registry (api/00 §7, §7.1 `issues` detail), WS/SSE message schemas (api/00 §12 — frame shape + `sync.poke`), and the rejection-code enum (05 §8, all eight codes incl. `CHAIN_HALTED`). Request schemas are `.strict()`; response schemas are tolerant of unknown keys (api/00 §2.1/§4 forward-compat split). This is a **contended package** (CLAUDE.md §4 / _index serialization note): it serializes with tasks 06, 08, 10, 11 — land before dependents start.

## Docs to read

- `05-operation-log.md` — §2.1–2.4 (envelope layers, field-by-field), §3 (absent-vs-null rule, integer/decimal-string number rules, integer-IDR money), §8 (rejection codes + client behavior column).
- `api/00-conventions.md` — §2.1 (global schema rules), §4 (client tolerance obligations), §6 (response envelope), §7 + §7.1 (HTTP code registry, `details` shapes, `issues` mapping), §12 (WS frame shape, `sync.poke`, SSE event), §14 (this package is the single schema definition for `zValidator` and client pre-send validation).
- `api/01-sync.md` — §3 (push request/response, ≤ 500 ops, per-op result statuses), §4 (pull request/response), §4.1 (`DeviceInfo` sidecar, `devicesDirectoryVersion`), §4.2 (what the quarantine path consumes).
- `08-stack-and-repo.md` — §3.2 `@bolusi/schemas` row, §3.3 (imports: `zod` only; platform-free), §3.4 (three locks), §4.1 (`exactOptionalPropertyTypes` is load-bearing for absent-vs-null), §5.2 (`bolusi/no-float-money` scope).

## Skills

- `superpowers:test-driven-development` — always.
- `superpowers:verification-before-completion` — run the gates, read the output, then claim done.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on main.

## Files / modules touched

All under `packages/schemas/` (**contended** — serialize with 06/08/10/11):

- `packages/schemas/src/primitives.ts` — shared brands/guards: UUIDv7 string, 64-hex hash, base64, ms-epoch integer, `zMoneyIdr` (integer IDR, refuses floats), payload-number helper (integer or decimal string, 05 §3).
- `packages/schemas/src/envelope.ts` — `SignedCore` (05 §2.1, `.strict()`, nullable-never-optional), `SignedOperation` (core + `hash`/`signature`, 05 §2.2).
- `packages/schemas/src/bookkeeping.ts` — client bookkeeping (`syncStatus` machine values, `syncedAt`, `rejectionCode`/`rejectionReason`; 05 §2.3) + server bookkeeping (`serverSeq`, `receivedAt`, `clockSkewFlagged`; 05 §2.4). Types only consumed by db layers — never merged into the signed core.
- `packages/schemas/src/rejection-codes.ts` — the eight-code enum (05 §8).
- `packages/schemas/src/sync.ts` — push request/response, pull request/response, `PushResult`, `DeviceInfo` (api/01 §3–4.1).
- `packages/schemas/src/errors.ts` — error envelope, `HttpErrorCode` registry (all 13 codes, api/00 §7), per-code `details` shapes incl. §7.1 `issues`.
- `packages/schemas/src/ws.ts` — WS frame schema `{ type, payload }` + `sync.poke` message schema (api/00 §12.1).
- `packages/schemas/src/index.ts` — public exports (schemas + inferred types).
- `packages/schemas/test/*.test.ts` — unit suites below; `packages/schemas/test/types.test-d.ts` (or equivalent compile-checked file) — the compile test.
- `packages/schemas/package.json`, `tsconfig.json` — only if task 01's scaffold needs completing; must stay `zod`-only, platform-free `base.json` variant.

## Acceptance

Observable done-condition: `pnpm --filter @bolusi/schemas test`, `pnpm typecheck` (`tsc -b` incl. this package's `dist/` emit), and `pnpm lint` all pass; every schema/type in the Goal is exported from the package index.

Unit tests (concrete; each bullet = at least one test):

- **Envelope happy path:** a fully-populated valid signed core parses; a genesis op with `previousHash` of 64 zeros and `seq: 1` parses.
- **Absent-vs-null rule (05 §3):** for each nullable core field (`storeId`, `location`, `agentConversationId`) — key present with `null` parses; key **absent** fails. No `.optional()` anywhere in the signed core (compile test asserts inferred types are `T | null`, not `T | undefined`, under `exactOptionalPropertyTypes`).
- **Unknown-key rejection:** an extra key on the signed core, on the push request, on the pull request, and on a `location` object fails parse (`.strict()` on all request-direction schemas).
- **Response tolerance split:** pull response / push response / error envelope with an extra unknown field still parse (api/00 §2.1/§4); WS frame with unknown `type` parses at frame level (client-ignore contract, api/00 §12.1) while the `sync.poke` schema rejects a non-empty payload.
- **Field guards:** `seq: 0`, non-integer `seq`, non-integer `timestamp`, `schemaVersion: 0`, `previousHash` of wrong length / non-hex, `source` outside the four-value enum, non-boolean `agentInitiated` — each fails.
- **Money-integer refusal:** `zMoneyIdr` accepts integers, rejects `10.5`, `NaN`, `Infinity`, and numeric strings where a number is required; the payload-number helper accepts integers and decimal strings, rejects float literals (05 §3).
- **Rejection-code enum:** exactly `BAD_SIGNATURE, CHAIN_BROKEN, CHAIN_GAP, CHAIN_HALTED, DEVICE_REVOKED, SCHEMA_INVALID, SCOPE_VIOLATION, UNKNOWN_TYPE` — a test asserts the full value set (catches silent additions/removals).
- **Sync DTOs:** push request rejects 501 ops (`max 500`, api/01 §3) and a missing `deviceId`; `PushResult` accepts each of `accepted`/`duplicate`/`rejected` shapes and rejects an unknown `status`; pull request rejects a negative `cursor` and non-integer `devicesDirectoryVersion`; `DeviceInfo` accepts `kind: 'member' | 'system'` only, `revokedAt` nullable-present, and a revoked device row parses (revoked devices stay listed, api/01 §4.1).
- **Error registry:** `HttpErrorCode` set is exactly the 13 codes of api/00 §7 (asserted as a full-set test); envelope with an unknown `code` still parses (forward-compat) while the exported known-code enum excludes it; `details` shapes for `VALIDATION_FAILED` (`issues[*].path` of `(string|number)[]`, `code`, `message` — nothing else), `BODY_TOO_LARGE`/`DECOMPRESSED_TOO_LARGE` (`limitBytes`), `RATE_LIMITED` (`retryAfterSeconds`), `INTERNAL` (`requestId`) each round-trip.
- **Bookkeeping:** `syncStatus` accepts only `local | synced | rejected`; server bookkeeping requires integer `serverSeq`/`receivedAt` and boolean `clockSkewFlagged`.
- **Compile test:** a type-level test file consumed by `tsc -b` imports every exported inferred type (`SignedCore`, `SignedOperation`, `PushRequest`, `PushResponse`, `PullRequest`, `PullResponse`, `DeviceInfo`, `ErrorEnvelope`, `WsMessage`, `RejectionCode`, `HttpErrorCode`, bookkeeping types) and asserts key shapes (e.g. `storeId: string | null`); optionality drift breaks the build.

SEC-\*/CHAOS-\*: **none execute in this task** — this package is pure definitions with no runtime surface (no auth, no transport, no storage). The schemas it exports are the fixtures for downstream adversarial suites and must not be weakened: SEC-RT-03 validates emitted frames against the frozen `sync.poke` schema defined here; SEC-SYNC-06 exercises the push request schema; CHAOS-05's rejection matrix consumes the rejection-code enum. Reviewer check: every id/shape those tests name resolves to an export of this package.

Lint/CI gates:

- `bolusi/no-float-money` passes over `packages/schemas` (rule scope per 08 §5.2) — and a deliberate `z.number()`-without-`.int()` fixture is verified to fail it locally before removal.
- `bolusi/boundaries` passes: `zod` is the only import; platform-free tsconfig (`types: []`, `lib: ["ES2022"]`) compiles clean.
- Package unit tests run in Node CI on every PR (`pnpm test`, testing-guide L1); package is wired into the root `tsc -b` solution references.
- Conventional, subject-only commits; pre-commit hooks green (CLAUDE.md §2.4/§2.10).
