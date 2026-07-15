// The contiguous-serverSeq walk against the driver PRODUCTION ACTUALLY USES (task 46).
//
// WHY THIS FILE EXISTS IN db-server AND NOT IN packages/core, WHERE THE CODE LIVES
// ---------------------------------------------------------------------------------
// `highestContiguousServerSeq` reads `operations.server_seq` — a `bigint` (10-db §5). The real
// `pg` driver returns int8 as a **JS string**: int8's range exceeds JS's safe integers, so
// node-postgres refuses to narrow it silently. The walk compared `row.serverSeq === watermark + 1`
// against an asserted-`number` result type, so on real Postgres it compared `"1" === 1` → false,
// forever, and returned `from` unchanged. `applied_server_seq` never advanced server-side. No
// throw, no red test — the watermark simply stopped.
//
// Every lane that existed was blind to it BY CONSTRUCTION (testing-guide T-8, T-14f):
//
//   lane                      driver           int8 comes back as
//   ------------------------  ---------------  ------------------
//   @bolusi/core unit tests   better-sqlite3   number
//   applier-conformance (T-8) PGlite           number
//   production + test:rls     real `pg`        STRING  ← only this one reproduces
//
// PGlite embeds a real PostgreSQL, so it proves SQL DIALECT neutrality honestly — but it is a
// different CLIENT, and the client is what decides the JS type you get back. A gate labelled
// "SQLite vs Postgres" was really "SQLite vs *a* Postgres, over a driver production never uses".
// So this test lives where the real driver is: `pnpm test:rls` runs THIS project against an
// attributed Postgres 16 through `pg`. There is no way to write it in packages/core, whose
// devDependencies are better-sqlite3 and PGlite — and `pg` is boundary-locked to this package
// (08 §3.3). A core-only version of this test would pass with the fix reverted: the bug's alibi.
//
// The T-8 gate has a SECOND hole this file also covers: the conformance suite only ever calls
// `applyAppendedOp`, which takes engine.ts's `advanceLocalSeq` branch. The pull branch — the sole
// caller of `highestContiguousServerSeq` — is never executed on the Postgres leg at all.
import { highestContiguousServerSeq } from '@bolusi/core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { seedOperation, seedTenant, type TenantFixture } from './helpers/fixtures.js';
import { createTestDb, ENGINE, type TestDb } from './helpers/test-db.js';

let testDb: TestDb;
let tenant: TenantFixture;

// A hole at 4: seeded present are 1,2,3 and 5,6. The walk must stop at 3 and, resumed from 4,
// reach 6. `operations` is append-only (0003's forbid_mutation trigger), so a test cannot delete
// rows to reshape this — the seeding is therefore done once and the cases below only READ it.
// The one case that inserts (filling the hole) is last in the file and says so.
beforeAll(async () => {
  testDb = await createTestDb();
  tenant = await seedTenant(testDb.db);
  for (const serverSeq of [1n, 2n, 3n, 5n, 6n]) {
    await seedOperation(testDb.db, tenant, serverSeq);
  }
}, 120_000);

afterAll(async () => {
  await testDb?.close();
});

describe('lane coverage (T-14 — a guard must assert its own coverage)', () => {
  test('reports which engine and driver produced these results', () => {
    // Numbers from this file mean entirely different things per lane: on PGlite the walk passes
    // whether or not the fix is present. Make the lane explicit rather than let a reader assume
    // the strong one.
    expect(['pglite', 'postgres']).toContain(ENGINE);
  });

  test('the fixture actually has rows — an empty log walks to `from` and reads like a pass', async () => {
    // T-14b: the shared docker daemon means a neighbour resetting the schema mid-run leaves the
    // tables and ZERO rows. `highestContiguousServerSeq(db, 0)` over an empty log returns 0 —
    // indistinguishable from the very bug this file exists to catch. Assert the fixture inline.
    const rows = await testDb.db.selectFrom('operations').select('serverSeq').execute();
    expect(rows.map((r) => Number(r.serverSeq)).sort((a, b) => a - b)).toEqual([1, 2, 3, 5, 6]);
  });

  test('this lane marshals int8 the way the lane is supposed to', async () => {
    // THE LOAD-BEARING ASSERTION OF THIS FILE. The walk test below only proves something on the
    // postgres lane if int8 genuinely arrives as a string there — that string is the bug's whole
    // mechanism. If a future pg release, a pool-level `setTypeParser`, or a driver swap started
    // handing back numbers, the walk test would go green for the WRONG REASON and this file would
    // silently stop covering anything, exactly as T-8 did. So assert the precondition rather than
    // assume it: this test fails LOUDLY the day the coverage evaporates.
    const result = await sql<{ serverSeq: unknown }>`
      SELECT server_seq FROM operations ORDER BY server_seq LIMIT 1
    `.execute(testDb.db);
    const value = result.rows[0]?.serverSeq;

    expect(typeof value).toBe(ENGINE === 'postgres' ? 'string' : 'number');
  });
});

describe('highestContiguousServerSeq over the real op log', () => {
  test('advances across a contiguous run', async () => {
    // THE REGRESSION. Before the fix this returned 0 on the postgres lane (`"1" === 0 + 1` is
    // false, so the walk never advanced) while returning 3 on PGlite. Removing the int8
    // normalisation in oplog-source.ts turns this line red on `pnpm test:rls` and ONLY there.
    expect(await highestContiguousServerSeq(testDb.db, 0)).toBe(3);
  });

  test('stops below a gap and stays there', async () => {
    // 4 is missing, so a watermark at 3 cannot advance to 5: contiguity pins it (04 §4.3).
    expect(await highestContiguousServerSeq(testDb.db, 3)).toBe(3);
  });

  test('resumes past a filled-from cursor and walks the rest of the run', async () => {
    // From 4, the present 5 and 6 are contiguous — proves the walk advances MULTIPLE steps, not
    // just one. A fix that only ever moved a single step would pass the first case and fail here.
    expect(await highestContiguousServerSeq(testDb.db, 4)).toBe(6);
  });

  test('an op-log value beyond 2^53 fails LOUDLY instead of silently rounding', async () => {
    // The claim the fix's shape rests on (task 46): `server_seq` is a bigint, so it is not JS's
    // job to decide it fits in a double. A plain `Number()` would round 2^53+1 down to 2^53 and
    // hand back a WRONG watermark with no error — the same silent-wrong-answer failure this task
    // fixes, wearing a different hat one magnitude up. This makes that claim checkable rather
    // than a comment: exceed the range and the walk must refuse.
    const beyond = 9_007_199_254_740_993n; // 2^53 + 1 — not representable as a JS number
    await seedOperation(testDb.db, tenant, beyond);

    await expect(highestContiguousServerSeq(testDb.db, 9_007_199_254_740_992)).rejects.toThrow(
      /server_seq/,
    );
  });

  test('LAST — filling the hole lets the walk cross it in one pass', async () => {
    // Inserts, so it must run after the read-only cases above. 4 arrives (a late pull), and the
    // watermark that was pinned at 3 can now reach 6 in a single walk.
    await seedOperation(testDb.db, tenant, 4n);

    expect(await highestContiguousServerSeq(testDb.db, 0)).toBe(6);
  });
});
