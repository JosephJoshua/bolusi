# TASK 41 — the tenant-counter lock is taken *after* the chain-head read it should protect
**Status:** done
**Priority:** LOW (latent; a `UNIQUE` constraint makes it fail closed, not corrupt). Also fix the comment, which is currently false.
**Depends on:** 07

## Goal

Move `lockTenantCounter` above `loadDevice` so the lock is actually taken at transaction start — matching what both the code comment and `10-db-schema §3` already claim happens.

**The finding** (review-03, task 07 review — a NEW finding, not self-reported by task 07):

```
apps/server/src/oplog/pipeline.ts:82    const device = await loadDevice(...)          // reads lastSeq/lastHash (the chain head)
apps/server/src/oplog/pipeline.ts:102   await lockTenantCounter(db, ...)              // lock taken HERE — too late
apps/server/src/oplog/pipeline.ts:105   let head = { seq: device.lastSeq, hash: ... } // uses the line-82 read; NEVER re-read after the lock
```

`server-seq.ts` comments that the row is *"locked FOR UPDATE at transaction start (serialising pushes per tenant)"* and `10-db §3` says *"Taken at transaction start."* **It isn't.** `loadDevice` runs first, the head is read before the lock, and it is never re-read after. No isolation level is set, so the transaction runs at **READ COMMITTED**. Two concurrent pushes from the **same device** can therefore both read the same chain head and both pass `classifyChain`.

**Why it's LOW and not a live corruption:** `UNIQUE (device_id, seq)` (`packages/db-server/migrations/0003_operations.ts:40`) makes the second insert fail. So the outcome is a **constraint error, not chain corruption** — fail-closed, just not by the mechanism the comment claims. And a same-device concurrent push is not a normal client shape (a device pushes its own chain serially).

**Why it's worth a task anyway — it is the same species we keep finding:** a docblock (and a normative spec line) asserting a property the code does not have. Task 10's brand comment claimed symbol privacy it didn't have; task 11's watermark docblock claimed dialect-neutrality it didn't have; here the lock comment and §3 claim an ordering the code doesn't implement. Each was harmless *today* and each is a trap for the next person who trusts the comment. The fix here is cheap and makes three things agree: the code, its comment, and the spec.

## Docs to read

- `apps/server/src/oplog/pipeline.ts` :82 (the early read), :102 (the late lock), :105 (the head that's never re-read).
- `apps/server/src/oplog/server-seq.ts` — the "locked at transaction start" comment that is currently false.
- `10-db-schema.md` §3 — "Taken at transaction start" (the normative claim the code must match, or the spec must change — decide which).
- `packages/db-server/migrations/0003_operations.ts:40` — the `UNIQUE (device_id, seq)` that makes this fail-closed today.
- `CLAUDE.md` §2.11; `testing-guide.md` T-11.

## Skills

- `superpowers:test-driven-development`, `superpowers:verification-before-completion`.
- Worktree isolation per CLAUDE.md §2.3 — first step: `git branch --show-current`; STOP if on `main`.
- **Real Postgres required** — this is a concurrency/isolation property; PGlite's single connection cannot express it. Use the per-worktree lane (task 34): `pnpm db:up` then `test:rls`, and confirm the `attribution OK` line names YOUR container before believing any result (T-14d).

## Files / modules touched

- `apps/server/src/oplog/pipeline.ts`, `server-seq.ts`. **Coordinate with task 16** (sync-server) — it builds the push endpoint around this pipeline; do not run concurrently.

## Acceptance

**Observable done-condition:** the chain-head read used by `classifyChain` happens *after* `lockTenantCounter`, so two concurrent same-device pushes serialise on the lock instead of racing to the `UNIQUE` constraint — and a test proves it on real Postgres.

- **Reproduce the race first** (T-11), on real PG16: fire two concurrent pushes from the same device against the *current* ordering and show they both read the same head (observable as the second failing on `UNIQUE (device_id, seq)` rather than on a clean chain-conflict rejection). If you cannot make them race, the premise is wrong — stop and report. **Assert your fixture actually achieved concurrency** (T-14b): two sequential pushes are not a proof; prove both transactions overlapped (e.g. both past the head-read before either commits).
- **Move the lock above `loadDevice`** (or re-read the head after locking — pick one and justify). The head feeding `classifyChain` must be the value read *under* the lock.
- **Falsify the fix** (§2.11): with the reorder, the two concurrent pushes serialise — the second sees the first's committed head and produces the *normal* chain outcome (accept-in-order or a clean `CHAIN_CONFLICT`), not a `UNIQUE` violation. Revert the reorder → the `UNIQUE` violation returns. Report both.
- **Do not weaken the `UNIQUE` backstop** — it stays as defence in depth. The reorder changes which mechanism catches the race (clean rejection vs constraint error), not whether it's caught.
- **Make the comment and the spec true.** `server-seq.ts`'s "at transaction start" and `10-db §3` must match the code once this lands. If you decide the current ordering is actually acceptable and the *comment* should change instead, that is a legitimate outcome — but then say why READ COMMITTED + `UNIQUE` is the intended design and correct §3 to describe it. One of {code, comment+spec} moves; they must agree at the end.
- `pnpm test`, `pnpm test:rls` (real PG16, attributed), `pnpm lint`, `pnpm typecheck` green. **Read the output, not the exit code** (§2.1).

## Note

Found by review-03, which reproduced task 07's two self-reported findings to the digit and then, chasing the lock's *rationale* rather than its presence, discovered the ordering didn't match the comment. That is the difference between reviewing whether a guard exists and reviewing whether it does what it says. The lock is genuinely load-bearing (removing it, with a read-modify-write counter, corrupts serverSeq — reproduced: `+3 not +15`); it is only the *timing* relative to the head-read that is off, and only the comment that is wrong about it.
