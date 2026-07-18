// Convergence, reorder/replay, and two-device offline merge (04 §8 boxes 3 & 6; testing-guide
// CHAOS-01/06/07 at MODULE scale — the harness-scale N-device runs land in task 26).
//
// The load-bearing property of the whole projection layer: ops arrive out of order routinely, and
// the projection must converge to the SAME rows regardless of arrival order (FR-1118). The ENGINE
// guarantees it (04 §4.2), so these feed one seeded op set in different arrival orders and assert
// identical final rows — AND that BOTH §4.2 paths were exercised (head-apply and re-fold counters
// > 0), because a run that never re-folded proves nothing about convergence (CHAOS-01's
// inconclusiveness rule). `edit_count` is the idempotency witness: a re-fold that double-applied
// would inflate it (testing-guide §3.2).
import { sql, type Kysely } from 'kysely';
import { afterEach, describe, expect, test } from 'vitest';

import type { SignedOperation } from '@bolusi/schemas';

import {
  DEVICE_A,
  DEVICE_B,
  deliver,
  noteId,
  op,
  openClientEngine,
  USER_A,
  USER_B,
  type ClientEngine,
} from './support/engines.js';

const engines: ClientEngine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.close();
});

async function fresh(): Promise<ClientEngine> {
  const e = await openClientEngine();
  engines.push(e);
  return e;
}

interface Row {
  id: string;
  body: string;
  editCount: number;
  archived: number;
  lastEditedBy: string;
}
async function readNotes(db: Kysely<never>): Promise<Map<string, Row>> {
  const rows = await sql<Row>`
    SELECT id, body, edit_count AS "editCount", archived, last_edited_by AS "lastEditedBy" FROM notes
  `.execute(db);
  return new Map(rows.rows.map((r) => [r.id, r]));
}

const N = noteId(1);

/** One note, same-entity contention across two devices (04 §8 box 3). Distinct (timestamp,
 *  deviceId, seq) so canonical order is total; canonically-latest is editB2 (t=5). */
function contendedSet(): SignedOperation[] {
  return [
    op(
      {
        type: 'notes.note_created',
        entityType: 'note',
        entityId: N,
        deviceId: DEVICE_A,
        userId: USER_A,
        timestamp: 1000,
        seq: 1,
        payload: { title: 'T', body: 'created', mediaId: null },
        schemaVersion: 2,
      },
      1,
    ),
    op(
      {
        type: 'notes.note_body_edited',
        entityType: 'note',
        entityId: N,
        deviceId: DEVICE_A,
        userId: USER_A,
        timestamp: 2000,
        seq: 2,
        payload: { body: 'a1' },
      },
      2,
    ),
    op(
      {
        type: 'notes.note_body_edited',
        entityType: 'note',
        entityId: N,
        deviceId: DEVICE_B,
        userId: USER_B,
        timestamp: 3000,
        seq: 1,
        payload: { body: 'b1' },
      },
      3,
    ),
    op(
      {
        type: 'notes.note_body_edited',
        entityType: 'note',
        entityId: N,
        deviceId: DEVICE_A,
        userId: USER_A,
        timestamp: 4000,
        seq: 3,
        payload: { body: 'a2' },
      },
      4,
    ),
    op(
      {
        type: 'notes.note_body_edited',
        entityType: 'note',
        entityId: N,
        deviceId: DEVICE_B,
        userId: USER_B,
        timestamp: 5000,
        seq: 2,
        payload: { body: 'b2 (canonically-latest)' },
      },
      5,
    ),
  ];
}

describe('convergence + reorder/replay (04 §8 box 3)', () => {
  test('canonical order and a shuffled order fold to identical rows, hitting BOTH §4.2 paths', async () => {
    const set = contendedSet();

    // Control: canonical order (04 §4.2 head case only — every op is the newest so far).
    const control = await fresh();
    for (const o of set) await deliver(control.db, control.engine, o);
    const controlRows = await readNotes(control.db);

    // Shuffled: latest first, then earlier ops (forces re-folds).
    const shuffled = [set[4]!, set[0]!, set[3]!, set[1]!, set[2]!];
    const device = await fresh();
    for (const o of shuffled) await deliver(device.db, device.engine, o);
    const deviceRows = await readNotes(device.db);

    // Identical final rows across arrival orders (convergence).
    expect([...deviceRows.entries()]).toStrictEqual([...controlRows.entries()]);
    // The canonically-latest body won; edit_count counted every edit (no lost write, no double).
    expect(deviceRows.get(N)?.body).toBe('b2 (canonically-latest)');
    expect(deviceRows.get(N)?.editCount).toBe(4);
    expect(deviceRows.get(N)?.lastEditedBy).toBe(USER_B);

    // BOTH §4.2 paths exercised — else the convergence claim is inconclusive (CHAOS-01).
    const stats = device.engine.stats.snapshot();
    expect(stats.headApplies, 'head-apply path').toBeGreaterThan(0);
    expect(stats.refolds, 're-fold path').toBeGreaterThan(0);
  });

  test('replay/idempotency: re-delivering an applied op is a duplicate no-op, edit_count stable (CHAOS-06)', async () => {
    const set = contendedSet();
    const e = await fresh();
    for (const o of set) expect(await deliver(e.db, e.engine, o)).toBe('applied');
    const before = await readNotes(e.db);
    expect(before.get(N)?.editCount).toBe(4);

    // Re-deliver every op: each is a DUPLICATE (05 §5 dedupe), so apply is never called again.
    for (const o of set) expect(await deliver(e.db, e.engine, o)).toBe('duplicate');
    const after = await readNotes(e.db);
    // edit_count identical before/after — proving no projection double-application (§3.2).
    expect([...after.entries()]).toStrictEqual([...before.entries()]);
  });

  test('FULL REBUILD equals the never-rebuilt control (04 §8 box 4)', async () => {
    const set = contendedSet();
    const control = await fresh();
    for (const o of set) await deliver(control.db, control.engine, o);
    const control_rows = await readNotes(control.db);

    const e = await fresh();
    for (const o of set) await deliver(e.db, e.engine, o);
    await e.engine.rebuild('notes');
    const rebuilt = await readNotes(e.db);
    expect([...rebuilt.entries()]).toStrictEqual([...control_rows.entries()]);
  });
});

describe('two-device offline merge (04 §8 box 6)', () => {
  const M = noteId(2);

  /** A shared note, then a concurrent body edit from each offline device. B is canonically later. */
  function mergeSet(): { create: SignedOperation; editA: SignedOperation; editB: SignedOperation } {
    const create = op(
      {
        type: 'notes.note_created',
        entityType: 'note',
        entityId: M,
        deviceId: DEVICE_A,
        userId: USER_A,
        timestamp: 1000,
        seq: 1,
        payload: { title: 'Shared', body: 'created', mediaId: null },
        schemaVersion: 2,
      },
      10,
    );
    const editA = op(
      {
        type: 'notes.note_body_edited',
        entityType: 'note',
        entityId: M,
        deviceId: DEVICE_A,
        userId: USER_A,
        timestamp: 2000,
        seq: 2,
        payload: { body: 'A offline edit' },
      },
      11,
    );
    const editB = op(
      {
        type: 'notes.note_body_edited',
        entityType: 'note',
        entityId: M,
        deviceId: DEVICE_B,
        userId: USER_B,
        timestamp: 3000, // canonically later than A
        seq: 1,
        payload: { body: 'B offline edit (later)' },
      },
      12,
    );
    return { create, editA, editB };
  }

  test('both arrival orders converge; winner = canonically-later op; edit_count counts BOTH', async () => {
    const { create, editA, editB } = mergeSet();

    // Device A receives its own edit, then B's (head case).
    const a = await fresh();
    for (const o of [create, editA, editB]) await deliver(a.db, a.engine, o);

    // Device B receives its own edit, then A's (which sorts EARLIER → re-fold).
    const b = await fresh();
    for (const o of [create, editB, editA]) await deliver(b.db, b.engine, o);

    const aRows = await readNotes(a.db);
    const bRows = await readNotes(b.db);
    expect([...aRows.entries()]).toStrictEqual([...bRows.entries()]);
    // Winner = editB (canonically later under (timestamp, deviceId, seq)); no edit lost.
    expect(aRows.get(M)?.body).toBe('B offline edit (later)');
    expect(aRows.get(M)?.lastEditedBy).toBe(USER_B);
    expect(aRows.get(M)?.editCount).toBe(2);
    // Device B's delivery must have taken the re-fold path (A's edit arrived out of order).
    expect(b.engine.stats.snapshot().refolds).toBeGreaterThan(0);
  });

  test('timestamp tie → the greater deviceId wins deterministically', async () => {
    const create = op(
      {
        type: 'notes.note_created',
        entityType: 'note',
        entityId: M,
        deviceId: DEVICE_A,
        userId: USER_A,
        timestamp: 1000,
        seq: 1,
        payload: { title: 'Tie', body: 'created', mediaId: null },
        schemaVersion: 2,
      },
      20,
    );
    // Same timestamp — the (deviceId, seq) tiebreak decides. DEVICE_B > DEVICE_A (byte order) wins.
    const editA = op(
      {
        type: 'notes.note_body_edited',
        entityType: 'note',
        entityId: M,
        deviceId: DEVICE_A,
        userId: USER_A,
        timestamp: 9000,
        seq: 2,
        payload: { body: 'device A body' },
      },
      21,
    );
    const editB = op(
      {
        type: 'notes.note_body_edited',
        entityType: 'note',
        entityId: M,
        deviceId: DEVICE_B,
        userId: USER_B,
        timestamp: 9000,
        seq: 1,
        payload: { body: 'device B body' },
      },
      22,
    );

    // Deliver in the order that puts A last, to prove the WINNER is chosen by canonical order, not
    // by arrival order — B still wins because DEVICE_B sorts after DEVICE_A at the tied timestamp.
    const e = await fresh();
    for (const o of [create, editB, editA]) await deliver(e.db, e.engine, o);
    const rows = await readNotes(e.db);
    expect(rows.get(M)?.body).toBe('device B body');
    expect(rows.get(M)?.lastEditedBy).toBe(USER_B);
  });
});
