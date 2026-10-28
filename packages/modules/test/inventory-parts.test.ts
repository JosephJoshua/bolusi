// Parts drawn for a servisan through the real runtime, and the guards the owner asked for so staff
// cannot cheat the stock (2026-10-28): parts come off the shelf only for a servisan being worked on,
// by its technician or the counter; only what a servisan took can go back; once the work is done
// only an owner corrects it. Also the count, stock below zero, and two phones converging.
import { afterEach, describe, expect, test } from 'vitest';

import { DomainError, refusalKeyOf } from '@bolusi/core';

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

async function expectRefused(p: Promise<unknown>, code: string, refusal?: string): Promise<void> {
  const err = await p.then(
    () => new Error(`expected ${code}, but the call resolved`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
  if (refusal !== undefined) expect(refusalKeyOf(err)).toBe(refusal);
}

interface Servisan {
  readonly ticketId: string;
  readonly use: { kind: 'repair_ticket'; id: string; label: string };
}

async function servisan(h: RepairHarness): Promise<Servisan> {
  const { ticketId, ticketNumber } = (await h.run('openTicket', intake(h), h.cashierId)) as {
    ticketId: string;
    ticketNumber: string;
  };
  return { ticketId, use: { kind: 'repair_ticket', id: ticketId, label: ticketNumber } };
}

/** A servisan the first technician is working on. */
async function inWork(h: RepairHarness): Promise<Servisan> {
  const s = await servisan(h);
  await h.run('startWork', { ticketId: s.ticketId, beforePhotos: [h.photo(1)] }, h.technicianId);
  return s;
}

async function addPart(h: RepairHarness, name: string, stock: number): Promise<string> {
  const { partId } = (await h.runInventory(
    'addPart',
    { name, code: null, fits: null },
    h.storeOwnerId,
  )) as { partId: string };
  if (stock > 0) {
    await h.runInventory('countStock', { counts: [{ partId, counted: stock }] }, h.storeOwnerId);
  }
  return partId;
}

async function onHand(h: RepairHarness, partId: string): Promise<number> {
  return (await h.queryInventory('getPart', { partId }, h.ownerId)).rows[0].onHand as number;
}

async function out(h: RepairHarness, s: Servisan, partId: string): Promise<number> {
  const used = (
    await h.queryInventory(
      'partsForUse',
      { useKind: 'repair_ticket', useId: s.ticketId },
      h.ownerId,
    )
  ).rows[0] as { parts: readonly { partId: string; out: number }[] };
  return used.parts.find((p) => p.partId === partId)?.out ?? 0;
}

describe('taking parts for a servisan', () => {
  test('its technician takes a part: stock drops and the servisan shows who took it', async () => {
    const h = await harness(6101);
    const lcd = await addPart(h, 'LCD Samsung A14', 3);
    const s = await inWork(h);

    await h.runInventory('takePart', { partId: lcd, qty: 2, use: s.use }, h.technicianId);

    expect(await onHand(h, lcd)).toBe(1);
    expect(await out(h, s, lcd)).toBe(2);
    const used = (
      await h.queryInventory(
        'partsForUse',
        { useKind: 'repair_ticket', useId: s.ticketId },
        h.ownerId,
      )
    ).rows[0];
    expect(used.movements).toHaveLength(1);
    expect(used.movements[0]).toMatchObject({ kind: 'taken', qty: -2, userId: h.technicianId });
  });

  test('another technician cannot take parts for it; the counter can', async () => {
    const h = await harness(6102);
    const lcd = await addPart(h, 'LCD', 5);
    const s = await inWork(h);

    await expectRefused(
      h.runInventory('takePart', { partId: lcd, qty: 1, use: s.use }, h.technician2Id),
      'PERMISSION_DENIED',
      'repair.refusal.partsNotYours',
    );
    await h.runInventory('takePart', { partId: lcd, qty: 1, use: s.use }, h.cashierId);
    expect(await onHand(h, lcd)).toBe(4);
  });

  test('a servisan not being worked on draws no parts, and nobody without the grant takes any', async () => {
    const h = await harness(6103);
    const lcd = await addPart(h, 'LCD', 5);
    const waiting = await servisan(h);
    await expectRefused(
      h.runInventory('takePart', { partId: lcd, qty: 1, use: waiting.use }, h.cashierId),
      'INVALID_TRANSITION',
      'repair.refusal.partsNotInWork',
    );

    const s = await inWork(h);
    await h.run(
      'markRepaired',
      { ticketId: s.ticketId, afterPhotos: [h.photo(2)] },
      h.technicianId,
    );
    await expectRefused(
      h.runInventory('takePart', { partId: lcd, qty: 1, use: s.use }, h.technicianId),
      'INVALID_TRANSITION',
      'repair.refusal.partsNotInWork',
    );
    await expectRefused(
      h.runInventory('takePart', { partId: lcd, qty: 1, use: s.use }, h.zeroUserId),
      'PERMISSION_DENIED',
    );
    expect(await onHand(h, lcd)).toBe(5);
  });

  test('the servisan number on a take must be the servisan’s own', async () => {
    const h = await harness(6104);
    const lcd = await addPart(h, 'LCD', 5);
    const s = await inWork(h);
    await expectRefused(
      h.runInventory(
        'takePart',
        { partId: lcd, qty: 1, use: { ...s.use, label: 'XXX-0001' } },
        h.technicianId,
      ),
      'VALIDATION_FAILED',
      'inventory.refusal.wrongUse',
    );
  });

  test('stock may go below zero, and the owner sees the part flagged', async () => {
    const h = await harness(6105);
    const lcd = await addPart(h, 'LCD', 1);
    await addPart(h, 'Baterai', 4);
    const s = await inWork(h);

    await h.runInventory('takePart', { partId: lcd, qty: 2, use: s.use }, h.technicianId);

    expect(await onHand(h, lcd)).toBe(-1);
    expect((await h.queryInventory('countBelowZero', {}, h.ownerId)).rows[0]).toStrictEqual({
      count: 1,
    });
    const flagged = await h.queryInventory('listParts', { filter: 'belowZero' }, h.ownerId);
    expect(flagged.rows.map((row) => row.id)).toStrictEqual([lcd]);
  });

  test('an archived part is not taken any more, but one already taken can still go back', async () => {
    const h = await harness(6106);
    const lcd = await addPart(h, 'LCD', 3);
    const s = await inWork(h);
    await h.runInventory('takePart', { partId: lcd, qty: 1, use: s.use }, h.technicianId);
    await h.runInventory(
      'editPart',
      { partId: lcd, name: 'LCD', code: null, fits: null, archived: true },
      h.storeOwnerId,
    );

    await expectRefused(
      h.runInventory('takePart', { partId: lcd, qty: 1, use: s.use }, h.technicianId),
      'INVALID_TRANSITION',
      'inventory.refusal.partArchived',
    );
    await h.runInventory('putBackPart', { partId: lcd, qty: 1, use: s.use }, h.technicianId);
    expect(await onHand(h, lcd)).toBe(3);
  });
});

describe('putting parts back', () => {
  test('only what the servisan took goes back, never more and never onto another servisan', async () => {
    const h = await harness(6201);
    const lcd = await addPart(h, 'LCD', 5);
    const s = await inWork(h);
    const other = await inWork(h);
    await h.runInventory('takePart', { partId: lcd, qty: 2, use: s.use }, h.technicianId);

    await expectRefused(
      h.runInventory('putBackPart', { partId: lcd, qty: 3, use: s.use }, h.technicianId),
      'VALIDATION_FAILED',
      'inventory.refusal.moreThanTaken',
    );
    await expectRefused(
      h.runInventory('putBackPart', { partId: lcd, qty: 1, use: other.use }, h.technicianId),
      'VALIDATION_FAILED',
      'inventory.refusal.moreThanTaken',
    );

    await h.runInventory('putBackPart', { partId: lcd, qty: 2, use: s.use }, h.technicianId);
    expect(await onHand(h, lcd)).toBe(5);
    expect(await out(h, s, lcd)).toBe(0);
    await expectRefused(
      h.runInventory('putBackPart', { partId: lcd, qty: 1, use: s.use }, h.technicianId),
      'VALIDATION_FAILED',
      'inventory.refusal.moreThanTaken',
    );
  });

  test('once the servisan is done, only an owner can correct its parts', async () => {
    const h = await harness(6202);
    const lcd = await addPart(h, 'LCD', 5);
    const s = await inWork(h);
    await h.runInventory('takePart', { partId: lcd, qty: 2, use: s.use }, h.technicianId);
    await h.run(
      'markRepaired',
      { ticketId: s.ticketId, afterPhotos: [h.photo(2)] },
      h.technicianId,
    );

    for (const userId of [h.technicianId, h.cashierId]) {
      await expectRefused(
        h.runInventory('putBackPart', { partId: lcd, qty: 1, use: s.use }, userId),
        'INVALID_TRANSITION',
        'repair.refusal.partsNotInWork',
      );
    }
    await h.runInventory('putBackPart', { partId: lcd, qty: 1, use: s.use }, h.storeOwnerId);
    expect(await onHand(h, lcd)).toBe(4);
    expect(await out(h, s, lcd)).toBe(1);
  });

  test('a cancelled servisan keeps its parts out until an owner puts them back', async () => {
    const h = await harness(6203);
    const lcd = await addPart(h, 'LCD', 2);
    const s = await inWork(h);
    await h.runInventory('takePart', { partId: lcd, qty: 1, use: s.use }, h.technicianId);
    await h.run('cancelTicket', { ticketId: s.ticketId, reason: 'Batal', fee: 0 }, h.storeOwnerId);

    await expectRefused(
      h.runInventory('putBackPart', { partId: lcd, qty: 1, use: s.use }, h.technicianId),
      'INVALID_TRANSITION',
      'repair.refusal.partsNotInWork',
    );
    expect(await out(h, s, lcd)).toBe(1);
    await h.runInventory('putBackPart', { partId: lcd, qty: 1, use: s.use }, h.ownerId);
    expect(await onHand(h, lcd)).toBe(2);
  });
});

describe('the parts list and counts', () => {
  test('only owners add parts and count stock', async () => {
    const h = await harness(6301);
    for (const userId of [h.cashierId, h.technicianId]) {
      await expectRefused(
        h.runInventory('addPart', { name: 'LCD', code: null, fits: null }, userId),
        'PERMISSION_DENIED',
      );
    }
    const lcd = await addPart(h, 'LCD', 0);
    await expectRefused(
      h.runInventory('countStock', { counts: [{ partId: lcd, counted: 9 }] }, h.technicianId),
      'PERMISSION_DENIED',
    );
  });

  test('a count sets the stock and records what the phone showed before', async () => {
    const h = await harness(6302);
    const lcd = await addPart(h, 'LCD', 4);
    await h.runInventory('countStock', { counts: [{ partId: lcd, counted: 3 }] }, h.storeOwnerId);
    const part = (await h.queryInventory('getPart', { partId: lcd }, h.ownerId)).rows[0];
    expect(part.onHand).toBe(3);
    expect(part.movements[0]).toMatchObject({ kind: 'counted', counted: 3, qty: -1 });
  });

  test('a take another phone had not synced still comes off a count', async () => {
    const a = await harness(6303);
    const lcd = await addPart(a, 'LCD', 5);
    const s = await inWork(a);
    const b = await openRepairHarness(6304, {
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
    for (const op of await a.ownOps()) await b.deliverPulled(op, arrival++);
    const synced = new Set((await a.ownOps()).map((op) => op.id));

    // Offline: the technician takes one on A while the owner counts 5 on B.
    await a.runInventory('takePart', { partId: lcd, qty: 1, use: s.use }, a.technicianId);
    await b.runInventory('countStock', { counts: [{ partId: lcd, counted: 5 }] }, b.storeOwnerId);

    for (const op of (await a.ownOps()).filter((op) => !synced.has(op.id))) {
      await b.deliverPulled(op, arrival++);
    }
    let arrivalA = 1000;
    for (const op of await b.ownOps()) {
      if (!synced.has(op.id)) await a.deliverPulled(op, arrivalA++);
    }
    expect(await onHand(a, lcd)).toBe(4);
    expect(await onHand(b, lcd)).toBe(4);
  });
});
