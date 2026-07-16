// Rule 1 + Rule 2's probes against the driver PRODUCTION ACTUALLY USES (01-domain-model §8.2).
//
// ── WHY THIS FILE EXISTS, AND WHY IT IS NOT IN apps/server ───────────────────────────────────
//
// The rules live in `apps/server/src/sync/conflict-detection.ts`, and their integration suite runs
// there on PGlite. That suite proves WHAT conflicts. It cannot prove this file's claim, because
// `pg` is boundary-locked to this package (08 §3.3) and `pnpm test:rls` — the only attributed
// real-PG16 lane — is `--project db-server`. So the two int8-bearing predicates are homed HERE and
// the pipeline calls them; this lane executes the SAME functions, not a copy (task 49's precedent
// for `createServerProjectionEngine`, task 47's for the watermark store).
//
// ── THE CLAIM THIS LANE OWNS (D16, T-14f) ────────────────────────────────────────────────────
//
// Rule 1 is `serverSeq(P) > lastPullCursor(O.device)`. Both operands are `int8` columns. The real
// `pg` driver returns int8 as a **JS string**; better-sqlite3 and PGlite return a **number**. Had
// this comparison been done in JS it would be `"10" > "9"` → false, so past cursor 9 the rule
// would silently stop firing: no throw, no red test on any substitute lane, and conflicts simply
// stop being detected in production. That is task 46 exactly, and T-14f measured the blindness —
// PGlite 14/14 green vs real `pg` 4 red.
//
// The implementation closes the class BY CONSTRUCTION rather than with a cast: the comparison is
// `WHERE o.server_seq > d.last_pull_cursor`, so Postgres compares int8 to int8 and no bigint ever
// crosses the driver to be compared in JS (§2.11 — a cast is a thing someone must remember, and
// task 46's bug WAS a missing cast that `tsc` believed). This file is what turns that from a claim
// into evidence, on PG16, over `pg`.
//
// The values below straddle 2^53 and the "9 vs 10" string-order boundary on purpose (T-12: test the
// class, not the instance you thought of).
import { existsPrecedingOp, findRule1Candidates } from '../src/index.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { seedOperation, seedTenant, uuid, type TenantFixture } from './helpers/fixtures.js';
import { createTestDb, ENGINE, type TestDb } from './helpers/test-db.js';

let testDb: TestDb;
let tenant: TenantFixture;
/** The OTHER device — Rule 1's `P.deviceId ≠ O.deviceId` needs two. */
let otherDeviceId: string;
let noteId: string;

const EDIT = 'notes.note_body_edited';
const ARCHIVE = 'notes.note_archived';

/** Set the pushing device's pull cursor — Rule 1's second operand (10-db §4). */
async function setCursor(value: bigint): Promise<void> {
  await testDb.db
    .updateTable('devices')
    .set({ lastPullCursor: value })
    .where('id', '=', tenant.deviceId)
    .execute();
}

beforeAll(async () => {
  testDb = await createTestDb();
  tenant = await seedTenant(testDb.db);
  noteId = uuid();

  // A second device inside the same tenant.
  otherDeviceId = uuid();
  await testDb.db
    .insertInto('devices')
    .values({
      id: otherDeviceId,
      tenantId: tenant.tenantId,
      storeId: tenant.storeId,
      kind: 'member',
      signingKeyPublic: `pubkey-${otherDeviceId}`,
      enrolledAt: 1_752_000_000_000n,
    })
    .execute();

  // The OTHER device's edit, at serverSeq 10. Ten is the whole point: as strings, "10" < "9", so a
  // JS-side comparison against cursor 9 would return FALSE ("10" > "9" is false) and the conflict
  // would vanish. As int8, 10 > 9. The two answers differ, and only one is right.
  await seedOperation(testDb.db, tenant, 10n, {
    type: EDIT,
    entityId: noteId,
    deviceId: otherDeviceId,
    timestampMs: 1_752_000_100_000n,
    seq: 5n,
  });
}, 120_000);

afterAll(async () => {
  await testDb?.close();
});

describe('lane coverage (T-14 / T-14f rule 3 — name which Postgres and which client)', () => {
  test('reports which engine and driver produced these results', () => {
    // Stated, not assumed: on PGlite every case below passes whether or not the comparison is done
    // in SQL, so a green here means nothing until the lane is named. `pnpm test:rls` sets
    // BOLUSI_DB_ENGINE=postgres and the global setup verifies the container's `bolusi.db_owner`
    // stamp before any test runs (T-14d) — so a number from this file has a provenance.
    console.info(`conflict-candidates lane: engine=${ENGINE} (real pg ⇒ int8 arrives as string)`);
    expect(['pglite', 'postgres']).toContain(ENGINE);
  });
});

describe('Rule 1 — serverSeq(P) > lastPullCursor(O.device) on the production driver', () => {
  test('HIT — cursor 9 vs serverSeq 10: the string comparison says no, int8 says yes', async () => {
    // THE T-14f CASE. `"10" > "9"` is false; `10 > 9` is true. This is the exact shape of task 46.
    await setCursor(9n);

    const candidates = await findRule1Candidates(testDb.db, {
      opId: uuid(),
      entityId: noteId,
      deviceId: tenant.deviceId,
      timestamp: 1_752_000_200_000,
      seq: 99,
      typesWithSameKey: [EDIT],
    });

    expect(candidates).toHaveLength(1);
    // The canonical-order verdict is Postgres's, over a row value (05 §4). P's timestamp is
    // 1_752_000_100_000 and the probe's is 1_752_000_200_000, so P sorts first.
    expect(candidates[0]?.beforeProbe).toBe(true);
  });

  test('MISS — cursor 10: the device HAS pulled P, so it is not a conflict', async () => {
    // The other side of the same comparison, and the POSITIVE CONTROL for the HIT above (T-17):
    // the rule is doing the work, not an empty table. Same fixture, one operand changed.
    await setCursor(10n);

    const candidates = await findRule1Candidates(testDb.db, {
      opId: uuid(),
      entityId: noteId,
      deviceId: tenant.deviceId,
      timestamp: 1_752_000_200_000,
      seq: 99,
      typesWithSameKey: [EDIT],
    });

    expect(candidates).toEqual([]);
  });

  test('MISS — the same device never conflicts with itself, at any cursor', async () => {
    await setCursor(0n);

    const candidates = await findRule1Candidates(testDb.db, {
      opId: uuid(),
      entityId: noteId,
      // Probing AS the other device: P.deviceId === O.deviceId ⇒ excluded.
      deviceId: otherDeviceId,
      timestamp: 1_752_000_200_000,
      seq: 99,
      typesWithSameKey: [EDIT],
    });

    expect(candidates).toEqual([]);
  });

  test('MISS — a type set that does not include P’s type finds nothing', async () => {
    await setCursor(0n);

    const candidates = await findRule1Candidates(testDb.db, {
      opId: uuid(),
      entityId: noteId,
      deviceId: tenant.deviceId,
      timestamp: 1_752_000_200_000,
      seq: 99,
      typesWithSameKey: [ARCHIVE],
    });

    expect(candidates).toEqual([]);
  });

  test('an EMPTY type set returns [] without compiling an `in ()` predicate', async () => {
    // An op whose type declares no conflict (01 §8.1). Kysely compiles `in []` to `in (null)` —
    // a predicate that silently matches nothing — so the function refuses the round trip instead.
    // Asserted because "returns []" and "matched nothing by accident" look identical (T-14b).
    await setCursor(0n);

    const candidates = await findRule1Candidates(testDb.db, {
      opId: uuid(),
      entityId: noteId,
      deviceId: tenant.deviceId,
      timestamp: 1_752_000_200_000,
      seq: 99,
      typesWithSameKey: [],
    });

    expect(candidates).toEqual([]);
  });

  test('BIG — the comparison holds past 2^53, where a JS number cannot represent the operands', async () => {
    // T-12: the class, not the instance. `Number("9007199254740993")` is 9007199254740992 — a
    // silent rounding. Postgres compares the int8s exactly. Two adjacent values above the safe
    // integer boundary must still order correctly, which is only true if neither side became a
    // JS number on the way.
    const bigTenant = await seedTenant(testDb.db);
    const bigNote = uuid();
    const bigOther = uuid();
    await testDb.db
      .insertInto('devices')
      .values({
        id: bigOther,
        tenantId: bigTenant.tenantId,
        storeId: bigTenant.storeId,
        kind: 'member',
        signingKeyPublic: `pubkey-${bigOther}`,
        enrolledAt: 1_752_000_000_000n,
      })
      .execute();
    await seedOperation(testDb.db, bigTenant, 9_007_199_254_740_993n, {
      type: EDIT,
      entityId: bigNote,
      deviceId: bigOther,
      timestampMs: 1_752_000_100_000n,
      seq: 5n,
    });

    const probe = {
      opId: uuid(),
      entityId: bigNote,
      deviceId: bigTenant.deviceId,
      timestamp: 1_752_000_200_000,
      seq: 99,
      typesWithSameKey: [EDIT],
    };

    // cursor = 9007199254740992 — ONE LESS than P's serverSeq. Both round to the same JS number.
    await testDb.db
      .updateTable('devices')
      .set({ lastPullCursor: 9_007_199_254_740_992n })
      .where('id', '=', bigTenant.deviceId)
      .execute();
    expect(await findRule1Candidates(testDb.db, probe)).toHaveLength(1);

    // cursor = P's serverSeq exactly ⇒ pulled ⇒ no conflict. A `Number()` round trip would make
    // these two cases indistinguishable, so this pair is the assertion.
    await testDb.db
      .updateTable('devices')
      .set({ lastPullCursor: 9_007_199_254_740_993n })
      .where('id', '=', bigTenant.deviceId)
      .execute();
    expect(await findRule1Candidates(testDb.db, probe)).toEqual([]);
  });
});

describe('Rule 2 — the canonical-order probe on the production driver (01 §8.2 / 03 §11)', () => {
  test('an archive canonically BEFORE the edit fires; one AFTER does not', async () => {
    const t = await seedTenant(testDb.db);
    const note = uuid();
    await seedOperation(testDb.db, t, 20n, {
      type: ARCHIVE,
      entityId: note,
      timestampMs: 1_752_000_500_000n,
      seq: 1n,
    });

    // An edit AFTER the archive in canonical order (05 §4) — N2 fires (03 §11).
    expect(
      await existsPrecedingOp(testDb.db, {
        entityId: note,
        types: [ARCHIVE],
        position: { timestamp: 1_752_000_600_000, deviceId: t.deviceId, seq: 2 },
      }),
    ).toBe(true);

    // An edit BEFORE the archive — the author archived their own note afterwards. Not a conflict:
    // 01 §8.2's parenthetical is "the editing device had not seen the archive". THE POSITIVE
    // CONTROL for the case above: same fixture, one operand moved.
    expect(
      await existsPrecedingOp(testDb.db, {
        entityId: note,
        types: [ARCHIVE],
        position: { timestamp: 1_752_000_400_000, deviceId: t.deviceId, seq: 2 },
      }),
    ).toBe(false);
  });

  test('an EMPTY type set is false without a round trip', async () => {
    expect(
      await existsPrecedingOp(testDb.db, {
        entityId: noteId,
        types: [],
        position: { timestamp: 1_752_000_600_000, deviceId: tenant.deviceId, seq: 2 },
      }),
    ).toBe(false);
  });
});
