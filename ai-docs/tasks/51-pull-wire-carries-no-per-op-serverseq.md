# TASK 51 — the pull wire carries no per-op `serverSeq`; the client cannot store the value 10-db §9.2 says it stores

**Status:** done
**Priority:** **MEDIUM** — not a live bug (v0's client-side numbering is self-consistent, see below), but a spec/wire divergence that becomes a real one the moment anything treats client `operations.server_seq` as the server's value, or a tenant grows a second store. Filed by task 15 rather than resolved there: the fix touches `@bolusi/schemas` and `apps/server`, both outside task 15's fence.
**Depends on:** 02, 15, 16

## The finding

`api/01-sync §4`'s pull response is:

```
→ { "ops": [SignedOperation...], "nextCursor": number, "hasMore": boolean, "serverTime": <ms>, ... }
```

`SignedOperation` is the signed core (05 §2.1) + `hash`/`signature`. **`serverSeq` is 05 §2.4 server-side bookkeeping, assigned at acceptance — i.e. after signing.** It is structurally impossible for it to ride inside the signed core, and no sibling field carries it. The server's pull *selects* `serverSeq` and then drops it (`apps/server/src/sync/pull.ts` → `reconstructWireOp`). The only server-assigned number on the wire is the batch's `nextCursor`.

But 10-db §9.2 specifies the client column as:

```sql
server_seq  INTEGER,   -- from push ack / pull; NULL while local
```

Neither half of that comment is currently true:

- **"from pull"** — impossible; the value is not on the wire.
- **"from push ack"** — no code path stores it. `BookkeepingPatch` (`packages/core/src/oplog/bookkeeping.ts`) deliberately excludes `serverSeq`, so a device's own pushed ops keep `server_seq` NULL by design.

## What task 15 did, and why

`packages/core/src/sync/pull.ts` (`nextArrivalSeq`) assigns pulled ops a **local, gapless, monotonic arrival counter** (`MAX(server_seq)+1`), documented at length in that function. It is sound for v0 for three reasons:

1. **Nothing else writes the column** (push never does), so there is no second numbering to collide with.
2. **It is what the watermark actually needs.** `highestContiguousServerSeq` pins `applied_server_seq` at the first hole. The client's op stream is scope-**filtered** (api/01 §4.3: this store's ops + tenant-scoped ones), so the server's true serverSeqs are inherently gappy on a multi-store tenant — storing them would pin the watermark below the first other-store op **forever**, silently freezing it (the same *class* of silent-stall bug as task 46, by a different route).
3. **The resume point is not this number.** `sync_state.pull_cursor` is the server's `nextCursor` and is the only value the protocol defines as the resume position. The arrival counter never leaves the device.

Task 08's own engine harness already models client `server_seq` this way (`test/projection/db.ts` `deliverPulled`), so this matches established practice rather than inventing a fourth model.

## Why it still needs a ruling

The column now means **two different things on the two sides** — arrival order on the client, true acceptance order on the server — while one DDL comment claims a single meaning. That is exactly the kind of quiet semantic drift that gets rediscovered as a bug:

- Anything that later compares client `operations.server_seq` to a cursor, a server value, or another device's value is wrong and will not fail loudly.
- Task 17 wiring the engine server-side (see task 48) puts both meanings in one codebase.
- Per-scope cursors (OQ-1103, v1) would make the client's true serverSeqs matter.

## Options (decide, then change the doc first per CLAUDE.md §6)

1. **Ratify the split.** Fix 10-db §9.2's comment to say the client column is a local arrival counter and the push ack's `serverSeq` is deliberately not stored; note the scope-gap reason. Cheapest; no wire change. Requires the watermark docblock in `projection/watermarks.ts` to stop claiming the client stream is "gapless per tenant" — it is gapless only *because* of the arrival counter, not because of 10-db §3.
2. **Put `serverSeq` on the wire.** Add a parallel `serverSeqs: number[]` (or `{op, serverSeq}[]`) to `zPullResponse` — it cannot go inside `SignedOperation` without breaking the hash preimage. Then the client stores true values and the watermark must be taught that the client stream is legitimately gappy (a `core/projection` change, coordinated with tasks 46/48).

Option 1 is likely right for v0; option 2 is the one v1's per-scope cursors may force.

## Acceptance

- A decision recorded in `ai-docs/decisions/`, and the owning doc (10-db §9.2, and `watermarks.ts`'s judgment-call docblock if option 1) changed **first**.
- If option 2: `zPullResponse` carries the values, `apps/server` serves them, `pull.ts` stores them, and the contiguity walk is made correct for a scope-filtered stream **with a test that fails on a multi-store tenant before the fix** (a positive control — the current suites all use single-store fixtures, which is why this is invisible today).
- Either way: a test that pins the chosen meaning of client `operations.server_seq`, so the next reader cannot re-derive the wrong one.
