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

async function addItem(h: RepairHarness, name: string, stock: number): Promise<string> {
  const { itemId } = (await h.runInventory(
    'addItem',
    { name, code: null, fits: [] },
    h.storeOwnerId,
  )) as { itemId: string };
  if (stock > 0) {
    await h.runInventory('countStock', { counts: [{ itemId, counted: stock }] }, h.storeOwnerId);
  }
  return itemId;
}

async function onHand(h: RepairHarness, itemId: string): Promise<number> {
  return (await h.queryInventory('getItem', { itemId }, h.ownerId)).rows[0].onHand as number;
}

async function out(h: RepairHarness, s: Servisan, itemId: string): Promise<number> {
  const used = (
    await h.queryInventory(
      'partsForUse',
      { useKind: 'repair_ticket', useId: s.ticketId },
      h.ownerId,
    )
  ).rows[0] as { parts: readonly { itemId: string; out: number }[] };
  return used.parts.find((p) => p.itemId === itemId)?.out ?? 0;
}

describe('taking parts for a servisan', () => {
  test('its technician takes a part: stock drops and the servisan shows who took it', async () => {
    const h = await harness(6101);
    const lcd = await addItem(h, 'LCD Samsung A14', 3);
    const s = await inWork(h);

    await h.runInventory('takePart', { itemId: lcd, qty: 2, use: s.use }, h.technicianId);

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
    const lcd = await addItem(h, 'LCD', 5);
    const s = await inWork(h);

    await expectRefused(
      h.runInventory('takePart', { itemId: lcd, qty: 1, use: s.use }, h.technician2Id),
      'PERMISSION_DENIED',
      'repair.refusal.partsNotYours',
    );
    await h.runInventory('takePart', { itemId: lcd, qty: 1, use: s.use }, h.cashierId);
    expect(await onHand(h, lcd)).toBe(4);
  });

  test('a servisan not being worked on draws no parts, and nobody without the grant takes any', async () => {
    const h = await harness(6103);
    const lcd = await addItem(h, 'LCD', 5);
    const waiting = await servisan(h);
    await expectRefused(
      h.runInventory('takePart', { itemId: lcd, qty: 1, use: waiting.use }, h.cashierId),
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
      h.runInventory('takePart', { itemId: lcd, qty: 1, use: s.use }, h.technicianId),
      'INVALID_TRANSITION',
      'repair.refusal.partsNotInWork',
    );
    await expectRefused(
      h.runInventory('takePart', { itemId: lcd, qty: 1, use: s.use }, h.zeroUserId),
      'PERMISSION_DENIED',
    );
    expect(await onHand(h, lcd)).toBe(5);
  });

  test('the servisan number on a take must be the servisan’s own', async () => {
    const h = await harness(6104);
    const lcd = await addItem(h, 'LCD', 5);
    const s = await inWork(h);
    await expectRefused(
      h.runInventory(
        'takePart',
        { itemId: lcd, qty: 1, use: { ...s.use, label: 'XXX-0001' } },
        h.technicianId,
      ),
      'VALIDATION_FAILED',
      'inventory.refusal.wrongUse',
    );
  });

  test('stock may go below zero, and the owner sees the part flagged', async () => {
    const h = await harness(6105);
    const lcd = await addItem(h, 'LCD', 1);
    await addItem(h, 'Baterai', 4);
    const s = await inWork(h);

    await h.runInventory('takePart', { itemId: lcd, qty: 2, use: s.use }, h.technicianId);

    expect(await onHand(h, lcd)).toBe(-1);
    expect((await h.queryInventory('countBelowZero', {}, h.ownerId)).rows[0]).toStrictEqual({
      count: 1,
    });
    const flagged = await h.queryInventory('listItems', { filter: 'belowZero' }, h.ownerId);
    expect(flagged.rows.map((row) => row.id)).toStrictEqual([lcd]);
  });

  test('an archived part is not taken any more, but one already taken can still go back', async () => {
    const h = await harness(6106);
    const lcd = await addItem(h, 'LCD', 3);
    const s = await inWork(h);
    await h.runInventory('takePart', { itemId: lcd, qty: 1, use: s.use }, h.technicianId);
    await h.runInventory(
      'editItem',
      { itemId: lcd, name: 'LCD', code: null, fits: [], archived: true },
      h.storeOwnerId,
    );

    await expectRefused(
      h.runInventory('takePart', { itemId: lcd, qty: 1, use: s.use }, h.technicianId),
      'INVALID_TRANSITION',
      'inventory.refusal.itemArchived',
    );
    await h.runInventory('putBackPart', { itemId: lcd, qty: 1, use: s.use }, h.technicianId);
    expect(await onHand(h, lcd)).toBe(3);
  });
});

describe('putting parts back', () => {
  test('only what the servisan took goes back, never more and never onto another servisan', async () => {
    const h = await harness(6201);
    const lcd = await addItem(h, 'LCD', 5);
    const s = await inWork(h);
    const other = await inWork(h);
    await h.runInventory('takePart', { itemId: lcd, qty: 2, use: s.use }, h.technicianId);

    await expectRefused(
      h.runInventory('putBackPart', { itemId: lcd, qty: 3, use: s.use }, h.technicianId),
      'VALIDATION_FAILED',
      'inventory.refusal.moreThanTaken',
    );
    await expectRefused(
      h.runInventory('putBackPart', { itemId: lcd, qty: 1, use: other.use }, h.technicianId),
      'VALIDATION_FAILED',
      'inventory.refusal.moreThanTaken',
    );

    await h.runInventory('putBackPart', { itemId: lcd, qty: 2, use: s.use }, h.technicianId);
    expect(await onHand(h, lcd)).toBe(5);
    expect(await out(h, s, lcd)).toBe(0);
    await expectRefused(
      h.runInventory('putBackPart', { itemId: lcd, qty: 1, use: s.use }, h.technicianId),
      'VALIDATION_FAILED',
      'inventory.refusal.moreThanTaken',
    );
  });

  test('once the servisan is done, only an owner can correct its parts', async () => {
    const h = await harness(6202);
    const lcd = await addItem(h, 'LCD', 5);
    const s = await inWork(h);
    await h.runInventory('takePart', { itemId: lcd, qty: 2, use: s.use }, h.technicianId);
    await h.run(
      'markRepaired',
      { ticketId: s.ticketId, afterPhotos: [h.photo(2)] },
      h.technicianId,
    );

    for (const userId of [h.technicianId, h.cashierId]) {
      await expectRefused(
        h.runInventory('putBackPart', { itemId: lcd, qty: 1, use: s.use }, userId),
        'INVALID_TRANSITION',
        'repair.refusal.partsNotInWork',
      );
    }
    await h.runInventory('putBackPart', { itemId: lcd, qty: 1, use: s.use }, h.storeOwnerId);
    expect(await onHand(h, lcd)).toBe(4);
    expect(await out(h, s, lcd)).toBe(1);
  });

  test('a cancelled servisan keeps its parts out until an owner puts them back', async () => {
    const h = await harness(6203);
    const lcd = await addItem(h, 'LCD', 2);
    const s = await inWork(h);
    await h.runInventory('takePart', { itemId: lcd, qty: 1, use: s.use }, h.technicianId);
    await h.run('cancelTicket', { ticketId: s.ticketId, reason: 'Batal', fee: 0 }, h.storeOwnerId);

    await expectRefused(
      h.runInventory('putBackPart', { itemId: lcd, qty: 1, use: s.use }, h.technicianId),
      'INVALID_TRANSITION',
      'repair.refusal.partsNotInWork',
    );
    expect(await out(h, s, lcd)).toBe(1);
    await h.runInventory('putBackPart', { itemId: lcd, qty: 1, use: s.use }, h.ownerId);
    expect(await onHand(h, lcd)).toBe(2);
  });
});

describe('the parts list and counts', () => {
  test('only owners add parts and count stock', async () => {
    const h = await harness(6301);
    for (const userId of [h.cashierId, h.technicianId]) {
      await expectRefused(
        h.runInventory('addItem', { name: 'LCD', code: null, fits: [] }, userId),
        'PERMISSION_DENIED',
      );
    }
    const lcd = await addItem(h, 'LCD', 0);
    await expectRefused(
      h.runInventory('countStock', { counts: [{ itemId: lcd, counted: 9 }] }, h.technicianId),
      'PERMISSION_DENIED',
    );
  });

  test('a count sets the stock and records what the phone showed before', async () => {
    const h = await harness(6302);
    const lcd = await addItem(h, 'LCD', 4);
    await h.runInventory('countStock', { counts: [{ itemId: lcd, counted: 3 }] }, h.storeOwnerId);
    const part = (await h.queryInventory('getItem', { itemId: lcd }, h.ownerId)).rows[0];
    expect(part.onHand).toBe(3);
    expect(part.movements[0]).toMatchObject({ kind: 'counted', counted: 3, qty: -1 });
  });

  /**
   * Two phones in one store that synced once, then went offline. The harness clocks put every
   * change on `early` before every change on `late`, as when one happened first in the shop.
   */
  async function twoPhones(seed: number) {
    const early = await harness(seed);
    const lcd = await addItem(early, 'LCD', 5);
    const s = await inWork(early);
    const late = await openRepairHarness(seed + 1, {
      tenantId: early.tenantId,
      storeId: early.storeId,
      users: [
        early.cashierId,
        early.technicianId,
        early.technician2Id,
        early.zeroUserId,
        early.ownerId,
        early.storeOwnerId,
      ],
    });
    open.push(late);
    let arrival = 1;
    for (const op of await early.ownOps()) await late.deliverPulled(op, arrival++);
    const synced = new Set((await early.ownOps()).map((op) => op.id));
    /** Both phones come back online and exchange what they did offline. */
    const sync = async () => {
      for (const op of await early.ownOps()) {
        if (!synced.has(op.id)) await late.deliverPulled(op, arrival++);
      }
      for (const op of await late.ownOps()) {
        if (!synced.has(op.id)) await early.deliverPulled(op, 1000 + arrival++);
      }
    };
    const both = async () => [await onHand(early, lcd), await onHand(late, lcd)];
    return { early, late, lcd, s, sync, both };
  }

  test('a take made after a count, synced after it, still comes off', async () => {
    const { early, late, lcd, s, sync, both } = await twoPhones(6303);
    await early.runInventory(
      'countStock',
      { counts: [{ itemId: lcd, counted: 5 }] },
      early.storeOwnerId,
    );
    await late.runInventory('takePart', { itemId: lcd, qty: 1, use: s.use }, late.technicianId);
    await sync();
    expect(await both()).toStrictEqual([4, 4]);
  });

  test('a take made before a count is already in what was counted', async () => {
    const { early, late, lcd, s, sync, both } = await twoPhones(6305);
    await early.runInventory('takePart', { itemId: lcd, qty: 1, use: s.use }, early.technicianId);
    // The owner counts the shelf after the part left it, on a phone that has not heard of the take.
    await late.runInventory(
      'countStock',
      { counts: [{ itemId: lcd, counted: 4 }] },
      late.storeOwnerId,
    );
    await sync();
    expect(await both()).toStrictEqual([4, 4]);
  });

  test('a part taken offline before an owner archived it is still accepted; one taken after is not', async () => {
    const { early, late, lcd, s } = await twoPhones(6309);
    await early.runInventory('takePart', { itemId: lcd, qty: 1, use: s.use }, early.technicianId);
    await late.runInventory(
      'editItem',
      { itemId: lcd, name: 'LCD', code: null, fits: [], archived: true },
      late.storeOwnerId,
    );
    const [before] = (await early.ownOps()).slice(-1);
    // Judged where the archive already landed, as the server would.
    await expect(late.checkRule(before!)).resolves.toBeUndefined();
    // The same take, had the phone's clock put it after the archive.
    await expectRefused(
      late.checkRule({ ...before!, timestamp: Number.MAX_SAFE_INTEGER }),
      'INVALID_TRANSITION',
      'inventory.refusal.itemArchived',
    );
  });

  test('of two counts made offline, the later one stands', async () => {
    const { early, late, lcd, sync, both } = await twoPhones(6307);
    await early.runInventory(
      'countStock',
      { counts: [{ itemId: lcd, counted: 3 }] },
      early.storeOwnerId,
    );
    await late.runInventory(
      'countStock',
      { counts: [{ itemId: lcd, counted: 2 }] },
      late.storeOwnerId,
    );
    await sync();
    expect(await both()).toStrictEqual([2, 2]);
  });
});

describe('when parts may move', () => {
  test('a servisan waiting for a part is still in work: the wrong part can go back', async () => {
    const h = await harness(6401);
    const lcd = await addItem(h, 'LCD', 2);
    const s = await inWork(h);
    await h.runInventory('takePart', { itemId: lcd, qty: 1, use: s.use }, h.technicianId);
    await h.run('markWaitingForParts', { ticketId: s.ticketId, note: 'LCD salah' }, h.technicianId);
    await h.runInventory('putBackPart', { itemId: lcd, qty: 1, use: s.use }, h.technicianId);
    expect(await onHand(h, lcd)).toBe(2);
  });

  test('nobody, not even an owner, draws parts for a servisan before work starts', async () => {
    const h = await harness(6402);
    const lcd = await addItem(h, 'LCD', 2);
    const waiting = await servisan(h);
    for (const userId of [h.ownerId, h.storeOwnerId]) {
      await expectRefused(
        h.runInventory('takePart', { itemId: lcd, qty: 1, use: waiting.use }, userId),
        'INVALID_TRANSITION',
        'repair.refusal.partsNotInWork',
      );
    }
  });
});

describe('searching the parts list', () => {
  // Regression: a search read only as many hits as the page, then dropped those the filter did
  // not want, so pages came back short and paging stopped early.
  test('a filtered search still fills its pages and pages to the end', async () => {
    const h = await harness(6501);
    const s = await inWork(h);
    const below: string[] = [];
    for (let n = 1; n <= 24; n += 1) {
      const itemId = await addItem(h, `LCD tipe ${String(n)}`, 1);
      if (n % 8 === 0) {
        await h.runInventory('takePart', { itemId, qty: 2, use: s.use }, h.technicianId);
        below.push(itemId);
      }
    }
    const seen: string[] = [];
    let offset = 0;
    for (;;) {
      const page = await h.queryInventory(
        'listItems',
        { text: 'lcd', filter: 'belowZero', limit: 2, offset },
        h.ownerId,
      );
      seen.push(...page.rows.map((row) => row.id as string));
      if (page.nextCursor === null) break;
      expect(page.rows).toHaveLength(2);
      offset = Number(page.nextCursor);
    }
    expect(seen.sort()).toStrictEqual([...below].sort());
  });
});

describe('the phones a part fits', () => {
  test('any name a servisan or the catalog can hold fits, and the take step can look it up', async () => {
    const h = await harness(6603);
    const brand = 'B'.repeat(100);
    const model = 'M'.repeat(200);
    await h.runInventory(
      'addItem',
      { name: 'LCD', code: null, fits: [{ brand, model }] },
      h.storeOwnerId,
    );
    const found = await h.queryInventory('itemsFitting', { brand, model }, h.technicianId);
    expect(found.rows.map((row) => row['name'])).toStrictEqual(['LCD']);
  });

  test('models are kept in order, once each, and an edit replaces them', async () => {
    const h = await harness(6601);
    const { itemId } = (await h.runInventory(
      'addItem',
      {
        name: 'LCD A14',
        code: null,
        fits: [
          { brand: 'Samsung', model: 'Galaxy A14' },
          { brand: 'samsung', model: 'galaxy a-14' },
          { brand: '', model: 'A14 5G' },
        ],
      },
      h.storeOwnerId,
    )) as { itemId: string };
    let part = (await h.queryInventory('getItem', { itemId }, h.ownerId)).rows[0];
    expect(part.models).toStrictEqual([
      { brand: 'Samsung', model: 'Galaxy A14' },
      { brand: '', model: 'A14 5G' },
    ]);
    expect(part.fits).toBe('Samsung Galaxy A14, A14 5G');

    await h.runInventory(
      'editItem',
      {
        itemId,
        name: 'LCD A14',
        code: null,
        fits: [{ brand: 'Samsung', model: 'Galaxy A15' }],
        archived: false,
      },
      h.storeOwnerId,
    );
    part = (await h.queryInventory('getItem', { itemId }, h.ownerId)).rows[0];
    expect(part.models).toStrictEqual([{ brand: 'Samsung', model: 'Galaxy A15' }]);
  });

  test('a servisan’s phone finds the parts that fit it, however it was written', async () => {
    const h = await harness(6602);
    const add = async (name: string, fits: { brand: string; model: string }[]) =>
      (
        (await h.runInventory('addItem', { name, code: null, fits }, h.storeOwnerId)) as {
          itemId: string;
        }
      ).itemId;
    const lcd = await add('LCD A57', [{ brand: 'Oppo', model: 'A57' }]);
    const port = await add('Konektor A57', [{ brand: '', model: 'A57' }]);
    await add('LCD A16', [{ brand: 'Oppo', model: 'A16' }]);
    const fitting = await h.queryInventory(
      'itemsFitting',
      { brand: 'OPPO', model: 'A-57' },
      h.technicianId,
    );
    expect(fitting.rows.map((row) => row.id).sort()).toStrictEqual([lcd, port].sort());
  });
});
