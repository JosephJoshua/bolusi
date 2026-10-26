// The owner's intake lists through the real runtime: who may change the franchise lists and who
// may only hide items at one store, the rules a saved list must meet, and that a ticket keeps the
// names it was opened with however the lists change later.
import { sql } from 'kysely';
import { afterEach, describe, expect, test } from 'vitest';

import { DomainError } from '@bolusi/core';

import {
  intakeOptionsChangedApplier,
  storeIntakeOptionsChangedApplier,
} from '../src/repair/applier.js';
import { DEFAULT_INTAKE_OPTIONS, storeIntakeOptions } from '../src/repair/intake-options.js';

import { intake, openRepairHarness, type RepairHarness } from './support/repair-harness.js';

const open: RepairHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function harness(seed: number): Promise<RepairHarness> {
  const h = await openRepairHarness(seed);
  open.push(h);
  return h;
}

async function expectCode(p: Promise<unknown>, code: string): Promise<DomainError> {
  const err = await p.then(
    () => new Error(`expected ${code}, but the call resolved`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
  return err as DomainError;
}

async function settings(h: RepairHarness, userId = h.cashierId) {
  return (await h.query('intakeOptionSettings', {}, userId)).rows[0];
}

const ownChecks = [
  { id: 'screen', label: null },
  { id: 'touch', label: 'Layar sentuh' },
  { id: null, label: 'Face ID' },
];

describe('changing the franchise lists', () => {
  test('a tenant has the built-in lists until the owner saves one', async () => {
    const h = await harness(1);
    const s = await settings(h);
    expect(s.lists).toStrictEqual(DEFAULT_INTAKE_OPTIONS);
    expect(Object.values(s.hidden).every((ids) => (ids as string[]).length === 0)).toBe(true);
  });

  test('the owner saves a list; a new item gets an id and the op is tenant-wide', async () => {
    const h = await harness(2);
    await h.run('changeIntakeOptions', { list: 'checks', items: ownChecks }, h.ownerId);

    const checks = (await settings(h)).lists.checks;
    expect(checks.slice(0, 2)).toStrictEqual([
      { id: 'screen', label: null },
      { id: 'touch', label: 'Layar sentuh' },
    ]);
    expect(checks[2].label).toBe('Face ID');
    expect(checks[2].id).toMatch(/^[0-9a-f-]{36}$/);

    const op = await h.db
      .selectFrom('operations')
      .select(['storeId', 'entityId', 'type'])
      .where('type', '=', 'repair.intake_options_changed')
      .executeTakeFirstOrThrow();
    expect(op).toStrictEqual({
      storeId: null,
      entityId: h.tenantId,
      type: 'repair.intake_options_changed',
    });
  });

  test('only a tenant-wide grant may change a list; a store owner and a cashier are refused', async () => {
    const h = await harness(3);
    for (const user of [h.cashierId, h.storeOwnerId, h.technicianId]) {
      await expectCode(
        h.run('changeIntakeOptions', { list: 'checks', items: ownChecks }, user),
        'PERMISSION_DENIED',
      );
    }
  });

  test('a list that breaks the rules is refused, as is saving it unchanged', async () => {
    const h = await harness(4);
    const refused = async (list: string, items: unknown[]) =>
      expectCode(
        h.run('changeIntakeOptions', { list, items } as never, h.ownerId),
        'VALIDATION_FAILED',
      );

    await refused('checks', [{ id: null, label: '   ' }]);
    await refused('checks', [{ id: null, label: 'x'.repeat(61) }]);
    await refused('checks', [
      { id: null, label: 'Layar' },
      { id: null, label: 'layar ' },
    ]);
    await refused('checks', [{ id: 'made-up', label: null }]);
    await refused('photoAngles', []);
    await refused('readyBy', [{ id: '61', label: null }]);
    await refused('readyBy', [{ id: '2', label: 'Lusa' }]);
    await refused(
      'brands',
      Array.from({ length: 41 }, (_, i) => ({ id: null, label: `Merek ${i}` })),
    );
    const unchanged = await refused('checks', [...DEFAULT_INTAKE_OPTIONS.checks]);
    expect(unchanged.details).toMatchObject({ issue: 'nothing changed' });

    // A list the counter can do without may be emptied.
    await h.run('changeIntakeOptions', { list: 'accessories', items: [] }, h.ownerId);
    expect((await settings(h)).lists.accessories).toStrictEqual([]);
  });
});

describe('hiding items at one store', () => {
  test('a store owner hides items here; the intake no longer offers them', async () => {
    const h = await harness(5);
    await h.run(
      'hideIntakeOptions',
      { list: 'checks', hidden: ['signal', 'biometrics'] },
      h.storeOwnerId,
    );

    const s = await settings(h);
    expect(s.hidden.checks).toStrictEqual(['signal', 'biometrics']);
    expect(s.lists.checks).toStrictEqual(DEFAULT_INTAKE_OPTIONS.checks);
    expect(storeIntakeOptions(s).checks.map((o: { id: string }) => o.id)).not.toContain('signal');

    const op = await h.db
      .selectFrom('operations')
      .select(['storeId', 'entityId'])
      .where('type', '=', 'repair.store_intake_options_changed')
      .executeTakeFirstOrThrow();
    expect(op).toStrictEqual({ storeId: h.storeId, entityId: h.storeId });
  });

  test('a cashier cannot hide items; the owner can, at any store', async () => {
    const h = await harness(6);
    await expectCode(
      h.run('hideIntakeOptions', { list: 'checks', hidden: ['signal'] }, h.cashierId),
      'PERMISSION_DENIED',
    );
    await h.run('hideIntakeOptions', { list: 'checks', hidden: ['signal'] }, h.ownerId);
  });

  test('ids not on the franchise list are dropped, and a must-have list keeps one item', async () => {
    const h = await harness(7);
    await h.run(
      'hideIntakeOptions',
      { list: 'checks', hidden: ['gone-already', 'camera', 'screen'] },
      h.storeOwnerId,
    );
    // Kept in the franchise list's order, unknown ids gone.
    expect((await settings(h)).hidden.checks).toStrictEqual(['screen', 'camera']);

    await expectCode(
      h.run(
        'hideIntakeOptions',
        { list: 'readyBy', hidden: ['0', '1', '3', 'unknown'] },
        h.storeOwnerId,
      ),
      'VALIDATION_FAILED',
    );
    await expectCode(
      h.run('hideIntakeOptions', { list: 'checks', hidden: ['camera', 'screen'] }, h.storeOwnerId),
      'VALIDATION_FAILED',
    );
  });

  test('if the owner later removes the last item a store shows, the store sees the whole list', async () => {
    const h = await harness(8);
    await h.run('hideIntakeOptions', { list: 'readyBy', hidden: ['0', '1', '3'] }, h.storeOwnerId);
    await h.run(
      'changeIntakeOptions',
      { list: 'readyBy', items: ['0', '1', '3'].map((id) => ({ id, label: null })) },
      h.ownerId,
    );
    const shown = storeIntakeOptions(await settings(h)).readyBy.map((o: { id: string }) => o.id);
    expect(shown).toStrictEqual(['0', '1', '3']);
  });
});

describe('tickets and changing lists', () => {
  test('a ticket must carry every photo angle the store asks for now', async () => {
    const h = await harness(9);
    await h.run(
      'changeIntakeOptions',
      {
        list: 'photoAngles',
        items: [...DEFAULT_INTAKE_OPTIONS.photoAngles, { id: null, label: 'Nomor IMEI' }],
      },
      h.ownerId,
    );
    // The six defaults alone are now short of the owner's list.
    await expectCode(h.run('openTicket', intake(h), h.cashierId), 'VALIDATION_FAILED');

    const imei = (await settings(h)).lists.photoAngles.at(-1);
    const input = intake(h);
    await h.run(
      'openTicket',
      {
        ...input,
        photos: [...input.photos, { slot: imei.id, label: 'Nomor IMEI', ref: h.photo(9) }],
      },
      h.cashierId,
    );

    // A store that hides an angle no longer needs it.
    const h2 = await harness(10);
    await h2.run('hideIntakeOptions', { list: 'photoAngles', hidden: ['bottom'] }, h2.storeOwnerId);
    const fewer = intake(h2);
    await h2.run(
      'openTicket',
      { ...fewer, photos: fewer.photos.filter((p) => p.slot !== 'bottom') },
      h2.cashierId,
    );
  });

  test('a ticket keeps the names it was opened with after the owner renames or removes them', async () => {
    const h = await harness(11);
    const input = intake(h, {
      checklist: [{ item: 'face-id', label: 'Face ID', state: 'issue', note: '' }],
      peripherals: [{ item: 'stylus', label: 'Stylus' }],
    });
    // The checklist names items the owner has on the list.
    await h.run(
      'changeIntakeOptions',
      { list: 'checks', items: [{ id: 'face-id', label: 'Face ID' }] },
      h.ownerId,
    );
    const { ticketId } = (await h.run('openTicket', input, h.cashierId)) as { ticketId: string };

    await h.run(
      'changeIntakeOptions',
      { list: 'checks', items: [{ id: 'face-id', label: 'Sidik wajah' }] },
      h.ownerId,
    );
    await h.run('changeIntakeOptions', { list: 'accessories', items: [] }, h.ownerId);

    const t = (await h.query('getTicket', { ticketId }, h.cashierId)).rows[0];
    expect(t.checklist).toStrictEqual([
      { item: 'face-id', label: 'Face ID', state: 'issue', note: '' },
    ]);
    expect(t.peripherals).toStrictEqual([{ item: 'stylus', label: 'Stylus' }]);
    expect(t.intakePhotos.map((p: { slot: string }) => p.slot)).toStrictEqual(
      input.photos.map((p) => p.slot),
    );
  });
  test('a ticket an older app opened (schema v1) still folds and reads with the six fixed angles', async () => {
    const a = await harness(15);
    await a.run('openTicket', intake(a), a.cashierId);
    const ops = await a.ownOps();
    const v2 = ops.find((op) => op.type === 'repair.ticket_opened')!;
    const p = v2.payload as Record<string, unknown> & {
      checklist: { item: string; state: string; note: string }[];
      peripherals: { item: string }[];
      photos: { slot: string; ref: unknown }[];
    };
    // What the v1 app wrote: no labels, accessories as ids, photos keyed by the six slots.
    const v1 = {
      ...v2,
      schemaVersion: 1,
      payload: {
        ...p,
        checklist: p.checklist.map(({ item, state, note }) => ({ item, state, note })),
        peripherals: p.peripherals.map(({ item }) => item),
        photos: Object.fromEntries(p.photos.map(({ slot, ref }) => [slot, ref])),
      },
    };

    const b = await openRepairHarness(16, {
      tenantId: a.tenantId,
      storeId: a.storeId,
      users: [
        a.cashierId,
        a.technicianId,
        a.technician2Id,
        a.zeroUserId,
        a.ownerId,
        a.storeOwnerId,
      ],
    });
    open.push(b);
    let arrival = 1;
    for (const op of ops) await b.deliverPulled(op === v2 ? (v1 as never) : op, arrival++);

    const t = (await b.query('getTicket', { ticketId: v2.entityId }, b.cashierId)).rows[0];
    expect(t.checklist[0]).toStrictEqual({
      item: 'screen',
      label: null,
      state: 'issue',
      note: 'retak kiri atas',
    });
    expect(t.peripherals[0]).toStrictEqual({ item: 'charger', label: null });
    expect(t.intakePhotos).toStrictEqual(
      DEFAULT_INTAKE_OPTIONS.photoAngles.map(({ id }) => ({ slot: id, label: null })),
    );
    expect(t.photos).toHaveLength(6);
  });
});

describe('the option tables as projections', () => {
  test('another device folds the owner’s and the store’s changes to the same rows, also on rebuild', async () => {
    const a = await harness(12);
    await a.run('changeIntakeOptions', { list: 'checks', items: ownChecks }, a.ownerId);
    await a.run('changeIntakeOptions', { list: 'checks', items: ownChecks.slice(0, 2) }, a.ownerId);
    await a.run('hideIntakeOptions', { list: 'checks', hidden: ['screen'] }, a.storeOwnerId);
    const ops = await a.ownOps();

    const b = await openRepairHarness(13, {
      tenantId: a.tenantId,
      storeId: a.storeId,
      users: [
        a.cashierId,
        a.technicianId,
        a.technician2Id,
        a.zeroUserId,
        a.ownerId,
        a.storeOwnerId,
      ],
    });
    open.push(b);
    // Arrive newest first: the fold must still end on the last write.
    let arrival = 1;
    for (const op of [...ops].reverse()) await b.deliverPulled(op, arrival++);

    const expected = await settings(a);
    expect(await settings(b)).toStrictEqual(expected);
    await b.engine.rebuild('repair');
    expect(await settings(b)).toStrictEqual(expected);
    expect(expected.lists.checks).toHaveLength(2);
  });

  test('an op whose entity is not its own tenant or store is ignored by the fold', async () => {
    const h = await harness(14);
    await h.run('changeIntakeOptions', { list: 'checks', items: ownChecks }, h.ownerId);
    await h.run('hideIntakeOptions', { list: 'checks', hidden: ['screen'] }, h.storeOwnerId);
    const [changed, hidden] = await h.ownOps();
    const other = '01920000-0000-7000-8000-00000000beef';
    const db = h.db as never;
    await intakeOptionsChangedApplier(db, {
      ...changed!,
      entityId: other,
      payload: { list: 'accessories', items: [] },
    });
    await storeIntakeOptionsChangedApplier(db, {
      ...hidden!,
      entityId: other,
      payload: { list: 'brands', hidden: ['oppo'] },
    });
    const s = await settings(h);
    expect(s.lists.accessories).toStrictEqual(DEFAULT_INTAKE_OPTIONS.accessories);
    expect(s.hidden.brands).toStrictEqual([]);
    const n = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM repair_intake_options`.execute(
      h.db,
    );
    expect(n.rows[0]!.n).toBe(1);
  });
});
