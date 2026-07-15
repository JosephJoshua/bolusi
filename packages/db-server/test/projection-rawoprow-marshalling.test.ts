// The projection engine's op-log DECODER against the driver production actually uses (task 48).
//
// WHY THIS FILE EXISTS IN db-server AND NOT IN packages/core, WHERE THE CODE LIVES
// ---------------------------------------------------------------------------------
// `reconstructOperation` (core/projection/oplog-source.ts) rebuilds a `SignedOperation` from an
// `operations` row. It was written against CLIENT marshalling — op-sqlite/better-sqlite3 — and the
// server's `operations` table is the same logical table with three columns that come back as
// different JS types (10-db §3; kysely-codegen already derives all three in db.d.ts):
//
//   column                 client (SQLite)  real `pg`          what the decoder did with it
//   ---------------------  ---------------  -----------------  ----------------------------------
//   seq, timestamp_ms      number           STRING (int8)      passed through as-is
//   payload, location      string (TEXT)    PARSED object      JSON.parse(object) → SyntaxError
//   agent_initiated        0 / 1            false / true       `row.agentInitiated !== 0`
//
// The middle one throws. The other two DO NOT, and that is the point of this file:
//
//   `"10" < "9"` is TRUE. Canonical order is `(timestamp, deviceId, seq)` (05 §4) and `seq` is a
//   per-device counter, so a log deeper than 9 ops — every real log — sorts WRONG through the
//   shared comparator, with no error. Tasks 08 and 35 proved the fold is order-INDEPENDENT; this
//   feeds it the wrong order to be independent of. FR-1118 rests on that order.
//
//   `false !== 0` is TRUE. Every op read back server-side reports `agentInitiated: true` — the
//   fraud model's attribution bit (02 §7, PRD-004) corrupted in the direction that EXCUSES the
//   human who actually acted.
//
// Every lane that existed was blind to the first BY CONSTRUCTION (testing-guide T-8, T-14f):
//
//   lane                      driver           int8 comes back as
//   ------------------------  ---------------  ------------------
//   @bolusi/core unit tests   better-sqlite3   number
//   applier-conformance (T-8) PGlite           number
//   production + test:rls     real `pg`        STRING  ← only this one reproduces
//
// PGlite embeds a real PostgreSQL, so it proves SQL DIALECT neutrality honestly — but it is a
// different CLIENT, and the client decides the JS type you get back. `pg` is boundary-locked to
// this package (08 §3.3), and packages/core's devDependencies are better-sqlite3 and PGlite, so
// there is no way to write this in core: a core-only version passes with the fix reverted. That
// is the bug's alibi, not its guard. Hence this file, next to the real driver.
import { readEntityOps, sortCanonical } from '@bolusi/core';
import { zSignedOperation } from '@bolusi/schemas';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { seedOperation, seedTenant, uuid, type TenantFixture } from './helpers/fixtures.js';
import { createTestDb, ENGINE, type TestDb } from './helpers/test-db.js';

let testDb: TestDb;
let tenant: TenantFixture;

// One entity per claim, so a case can never be satisfied by another case's rows.
const orderEntityId = uuid();
const decodeEntityId = uuid();
const attributionEntityId = uuid();
const envelopeEntityId = uuid();

// THE INVERSION FIXTURE. Same entity, same device, same timestamp — so `seq` is the ONLY
// tie-break left and canonical order is decided by it alone (05 §4). 9 and 10 because that is
// where lexicographic and numeric order first disagree: `"10" < "9"`.
//
// A note on `timestamp_ms`, which is int8 too and therefore equally a string on `pg`: it does NOT
// invert in practice, because ms-epoch stamps are all 13 digits until the year 2286 and
// same-length numeric strings compare lexicographically exactly as they do numerically. Its bug is
// the type, not the order — `timestamp` is declared `number` and arithmetic on it silently
// concatenates. The `seq` case is the sharp one and this file leads with it.
const EQUAL_TIMESTAMP = 1_752_000_000_000n;
const LOW_SEQ = 9n;
const HIGH_SEQ = 10n;

// Distinct, non-trivial values: a payload that is an OBJECT (not a string) proves the decoder
// returns the parsed thing rather than something that merely stringifies the same, and the nesting
// proves it is not shallow-copied.
const PAYLOAD = { title: 'inventory count', nested: { count: 42 }, tags: ['a', 'b'] };
const LOCATION = { lat: -6.2088, lng: 106.8456, accuracyMeters: 12.5 };
// 64 bytes of base64 — a shape `zBase64` accepts, so the envelope case can only fail on the
// columns this file is about (T-13: the oracle must be no looser than the claim).
const SIGNATURE = Buffer.alloc(64, 7).toString('base64');

beforeAll(async () => {
  testDb = await createTestDb();
  tenant = await seedTenant(testDb.db);

  await seedOperation(testDb.db, tenant, 1n, {
    entityId: orderEntityId,
    seq: LOW_SEQ,
    timestampMs: EQUAL_TIMESTAMP,
  });
  await seedOperation(testDb.db, tenant, 2n, {
    entityId: orderEntityId,
    seq: HIGH_SEQ,
    timestampMs: EQUAL_TIMESTAMP,
  });
  await seedOperation(testDb.db, tenant, 3n, {
    entityId: decodeEntityId,
    payload: PAYLOAD,
    location: LOCATION,
  });
  await seedOperation(testDb.db, tenant, 4n, {
    entityId: attributionEntityId,
    seq: 1n,
    agentInitiated: false,
  });
  await seedOperation(testDb.db, tenant, 5n, {
    entityId: attributionEntityId,
    seq: 2n,
    agentInitiated: true,
  });
  await seedOperation(testDb.db, tenant, 6n, {
    entityId: envelopeEntityId,
    signature: SIGNATURE,
    location: LOCATION,
  });
}, 120_000);

afterAll(async () => {
  await testDb?.close();
});

describe('lane coverage (T-14 — a guard must assert its own coverage)', () => {
  test('reports which engine and driver produced these results', () => {
    expect(['pglite', 'postgres']).toContain(ENGINE);
  });

  test('the fixture actually has the rows these cases read', async () => {
    // T-14b: a neighbour resetting the schema mid-run leaves the tables and ZERO rows, and every
    // case below would then assert over an empty array — `[].map(...)` equals `[]` and reads like
    // a pass. Assert the fixture inline rather than trust it.
    const rows = await testDb.db.selectFrom('operations').select('serverSeq').execute();
    expect(rows.map((r) => Number(r.serverSeq)).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('this lane marshals int8 the way the lane is supposed to', async () => {
    // THE LOAD-BEARING PRECONDITION. The order case below only proves anything on the postgres
    // lane if `seq` genuinely arrives as a string there — that string IS the bug's mechanism. If a
    // pg release, a pool-level `setTypeParser`, or a driver swap ever handed back numbers, the
    // order case would go green for the WRONG REASON and this file would silently stop covering
    // anything, exactly as the T-8 gate did. So assert the precondition: this fails LOUDLY the day
    // the coverage evaporates.
    const result = await sql<{ seq: unknown; timestampMs: unknown }>`
      SELECT seq, timestamp_ms FROM operations ORDER BY server_seq LIMIT 1
    `.execute(testDb.db);

    const expected = ENGINE === 'postgres' ? 'string' : 'number';
    expect(typeof result.rows[0]?.seq).toBe(expected);
    expect(typeof result.rows[0]?.timestampMs).toBe(expected);
  });

  test('this lane hands back jsonb PARSED, not as text', async () => {
    // The precondition behind the payload/location cases: on both Postgres clients `jsonb` arrives
    // already parsed, which is what makes `JSON.parse` on it throw. The client's TEXT column is
    // what hands back a string — and no lane here is the client.
    const result = await sql<{ payload: unknown; location: unknown }>`
      SELECT payload, location FROM operations WHERE entity_id = ${decodeEntityId}
    `.execute(testDb.db);

    expect(typeof result.rows[0]?.payload).toBe('object');
    expect(typeof result.rows[0]?.location).toBe('object');
  });

  test('this lane hands back boolean as a boolean, not 0/1', async () => {
    // The precondition behind the attribution cases. `agent_initiated` is `boolean NOT NULL`
    // server-side (0003) and `INTEGER NOT NULL DEFAULT 0` client-side — `false !== 0` is the bug.
    const result = await sql<{ agentInitiated: unknown }>`
      SELECT agent_initiated FROM operations WHERE entity_id = ${attributionEntityId}
      ORDER BY seq LIMIT 1
    `.execute(testDb.db);

    expect(typeof result.rows[0]?.agentInitiated).toBe('boolean');
  });
});

describe('canonical order (05 §4) — the silent one', () => {
  test('THE INVERSION: seq 10 sorts AFTER seq 9 through the shared comparator', async () => {
    // THE REGRESSION THIS TASK EXISTS FOR. Before the fix, on the postgres lane, `seq` came back
    // as "9"/"10" and `compareCanonicalOrder`'s `a.seq < b.seq` compared STRINGS: "10" < "9" is
    // true, so this returned [10, 9]. No throw, no error — a plausible order that is wrong for
    // every log deeper than 9 ops. Removing the int8 normalisation in oplog-source.ts turns this
    // line red on `pnpm test:rls` and ONLY there.
    const ops = await readEntityOps(testDb.db, 'note', orderEntityId);

    expect(sortCanonical(ops).map((o) => o.seq)).toEqual([9, 10]);
  });

  test('SQL canonical order equals the JS comparator on the real driver', async () => {
    // The invariant oplog-source.ts states in its header and core's own suite proves on SQLite:
    // the SQL `ORDER BY timestamp_ms, device_id, seq` and `compareCanonicalOrder` agree. SQL
    // sorts int8 numerically whatever the client, so a divergence here is JS-side by construction
    // — which is exactly what a stringified `seq` causes. The engine re-folds in the order
    // `readEntityOps` returns (engine.ts:142); the oracle and rebuild re-sort in JS. They must
    // not disagree.
    const ops = await readEntityOps(testDb.db, 'note', orderEntityId);

    expect(sortCanonical(ops).map((o) => o.id)).toEqual(ops.map((o) => o.id));
  });

  test('seq and timestamp arrive as the numbers the envelope declares', async () => {
    // `zSignedCore` says `seq: z.number().int().min(1)` and `timestamp: zMsEpoch` (05 §2.1). A
    // string that happens to sort right is still a lie to every arithmetic consumer downstream —
    // `op.timestamp + skew` would concatenate.
    const [first] = await readEntityOps(testDb.db, 'note', orderEntityId);

    expect(typeof first?.seq).toBe('number');
    expect(typeof first?.timestamp).toBe('number');
    expect(first?.timestamp).toBe(Number(EQUAL_TIMESTAMP));
  });
});

describe('jsonb decode — payload and location', () => {
  test('payload round-trips as the object it was written as', async () => {
    // Before the fix this threw `SyntaxError: "[object Object]" is not valid JSON` on the postgres
    // lane: the driver had already parsed the jsonb, and the decoder parsed it again.
    const [op] = await readEntityOps(testDb.db, 'note', decodeEntityId);

    expect(op?.payload).toEqual(PAYLOAD);
  });

  test('location round-trips — the same class as payload, twelve lines away', async () => {
    // `location` is `jsonb` server-side too (10-db §3), and the decoder JSON.parse'd it on the
    // identical assumption. Task 48's brief names `payload`; the column next to it has the same
    // bug, which is §2.8's point about what per-site handling does.
    const [op] = await readEntityOps(testDb.db, 'note', decodeEntityId);

    expect(op?.location).toEqual(LOCATION);
  });

  test('POSITIVE CONTROL: a null location stays null rather than becoming a decode artefact', async () => {
    // Guards the guard: without this, "location decodes" could be satisfied by a decoder that
    // returned some fixed object. The order fixture seeds no location, so it must read back null.
    const [op] = await readEntityOps(testDb.db, 'note', orderEntityId);

    expect(op?.location).toBeNull();
  });
});

describe('agentInitiated attribution (02 §7, PRD-004) — the other silent one', () => {
  test('an op written with agent_initiated = false reads back false', async () => {
    // THE REGRESSION. `row.agentInitiated !== 0` on a boolean `false` is `false !== 0` → TRUE, so
    // before the fix EVERY op read back agent-initiated on the postgres lane. Silently, and in the
    // direction that excuses the human who acted.
    const ops = await readEntityOps(testDb.db, 'note', attributionEntityId);

    expect(ops[0]?.agentInitiated).toBe(false);
  });

  test('POSITIVE CONTROL: an op written with agent_initiated = true reads back true', async () => {
    // Guards the guard. Without this, the case above is satisfied by a decoder hard-coding
    // `false` — which would corrupt attribution in the opposite direction just as silently.
    const ops = await readEntityOps(testDb.db, 'note', attributionEntityId);

    expect(ops[1]?.agentInitiated).toBe(true);
  });
});

describe('the whole envelope — the class, not the three known instances', () => {
  test('a server-written op reconstructs into a valid zSignedOperation', async () => {
    // T-12: test the CLASS. The three bugs above are the instances someone found; this asserts the
    // decoder's actual contract — "structurally identical to the object the append seam hands in"
    // — against the schema that DEFINES that shape, all 19 fields of it. A future column whose
    // driver type drifts (another int8, another jsonb) goes red here without anyone remembering to
    // add a case for it.
    const [op] = await readEntityOps(testDb.db, 'note', envelopeEntityId);

    const parsed = zSignedOperation.safeParse(op);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });
});
