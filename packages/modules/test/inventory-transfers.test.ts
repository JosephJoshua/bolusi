// Parts sent between stores through the real runtime (owner decisions 2026-11-25): stock leaves the
// sender at once, arrives at the receiver only when counted in, never more than was sent; what does
// not arrive stays "Belum sampai" until the sending owner settles it back into stock or writes it off
// with a reason; a cancel takes everything back but only before anything arrived; and an arrival
// recorded offline before a cancel still stands, leaving the transfer over for the owner to settle.
//
// Each store is its own phone. Between them only the ops a store would pull travel: the ops that
// name the other store (`otherStore`): the transfer's records, and the movements its parts left the
// sender's stock in, so only what really left can arrive. Nothing else of the sender's stock.
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

import { DomainError, refusalKeyOf } from '@bolusi/core';
import { initI18n } from '@bolusi/i18n';
import type { SignedOperation } from '@bolusi/schemas';

import enCatalog from '../inventory/i18n/en.json' with { type: 'json' };
import idCatalog from '../inventory/i18n/id.json' with { type: 'json' };
import { inventoryModule } from '../src/index.js';
import { registerInventoryCatalog } from '../src/inventory/i18n.js';
import { movementTitle } from '../src/inventory/labels.js';
import type { TransferDetailRow } from '../src/inventory/index.js';
import { openRepairHarness, type RepairHarness } from './support/repair-harness.js';

beforeAll(() => {
  initI18n({ locale: 'id' });
  registerInventoryCatalog({ id: idCatalog, en: enCatalog });
});

const open: RepairHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function expectRefused(p: Promise<unknown>, code: string, refusal?: string): Promise<void> {
  const err = await p.then(
    () => new Error(`expected ${code}, but the call resolved`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
  if (refusal !== undefined) expect(refusalKeyOf(err)).toBe(refusal);
}

/** Two stores of one business, one phone each, sharing the parts list. */
async function twoStores(seed: number) {
  const a = await openRepairHarness(seed);
  open.push(a);
  const b = await openRepairHarness(seed + 1, {
    tenantId: a.tenantId,
    storeId: '01920000-0000-7000-8000-00000000b0b0',
    users: [a.cashierId, a.technicianId, a.technician2Id, a.zeroUserId, a.ownerId, a.storeOwnerId],
  });
  open.push(b);
  const delivered = new Map<RepairHarness, Set<string>>([
    [a, new Set()],
    [b, new Set()],
  ]);
  let arrival = 1;
  /** What `to` would pull from `from`: tenant-wide ops (the parts list) and ops naming its store. */
  const sync = async (
    from: RepairHarness,
    to: RepairHarness,
    skip: (op: SignedOperation) => boolean = () => false,
  ) => {
    const seen = delivered.get(to)!;
    for (const op of await from.ownOps()) {
      if (seen.has(op.id) || skip(op)) continue;
      const declared = inventoryModule.operations[op.type];
      const reaches = op.storeId === null || declared?.otherStore?.(op.payload) === to.storeId;
      if (!reaches) continue;
      seen.add(op.id);
      await to.deliverPulled(op, arrival++);
    }
  };
  return { a, b, sync };
}

async function addItem(h: RepairHarness, name: string, stock = 0): Promise<string> {
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
  return (await h.queryInventory('getItem', { itemId }, h.storeOwnerId)).rows[0].onHand as number;
}

async function transfer(h: RepairHarness, transferId: string): Promise<TransferDetailRow> {
  return (await h.queryInventory('getTransfer', { transferId }, h.storeOwnerId))
    .rows[0] as TransferDetailRow;
}

/** Store A has 10 LCDs and 4 batteries and sends 5 and 2 to store B; B has the parts list. */
async function sent(seed: number) {
  const stores = await twoStores(seed);
  const { a, b, sync } = stores;
  const lcd = await addItem(a, 'LCD Redmi Note 10 + frame', 10);
  const battery = await addItem(a, 'Baterai Redmi Note 10', 4);
  const { transferId, transferNumber } = (await a.runInventory(
    'sendTransfer',
    {
      toStoreId: b.storeId,
      note: 'Untuk servisan besok',
      lines: [
        { itemId: lcd, qty: 5 },
        { itemId: battery, qty: 2 },
      ],
    },
    a.storeOwnerId,
  )) as { transferId: string; transferNumber: string };
  await sync(a, b);
  return { ...stores, lcd, battery, transferId, transferNumber };
}

/** The last op of `type` a phone saved. */
async function lastOp(h: RepairHarness, type: string): Promise<SignedOperation> {
  const ops = (await h.ownOps()).filter((op) => op.type === type);
  return ops[ops.length - 1]!;
}

describe('sending', () => {
  test('stock leaves the sender at once; the receiver sees it coming and nothing in stock yet', async () => {
    const { a, b, lcd, battery, transferId, transferNumber } = await sent(7301);
    expect(transferNumber).toMatch(/^TR-[0-9A-Z]{3}-0001$/);
    expect(await onHand(a, lcd)).toBe(5);
    expect(await onHand(a, battery)).toBe(2);
    expect(await onHand(b, lcd)).toBe(0);

    const out = await transfer(a, transferId);
    const incoming = await transfer(b, transferId);
    expect(out.direction).toBe('out');
    expect(incoming.direction).toBe('in');
    for (const row of [out, incoming]) {
      expect(row.stage).toBe('sent');
      expect(row.missingQty).toBe(7);
      expect(row.fromStoreId).toBe(a.storeId);
      expect(row.toStoreId).toBe(b.storeId);
    }
    expect(incoming.can.receive).toBe(true);
    const list = (await b.queryInventory('listTransfers', { direction: 'in' }, b.storeOwnerId))
      .rows;
    expect(list.map((row) => row.id)).toEqual([transferId]);
  });

  test("the sender's history says where the parts went", async () => {
    const { a, lcd, transferNumber } = await sent(7302);
    const item = (await a.queryInventory('getItem', { itemId: lcd }, a.storeOwnerId)).rows[0];
    const latest = item.movements[0];
    expect(latest.qty).toBe(-5);
    expect(movementTitle(latest)).toBe(`Dikirim lewat ${transferNumber}`);
  });

  test('a cashier without "Kirim sparepart antar toko" cannot send', async () => {
    const { a, b } = await twoStores(7303);
    const lcd = await addItem(a, 'LCD A', 3);
    await expectRefused(
      a.runInventory(
        'sendTransfer',
        { toStoreId: b.storeId, note: null, lines: [{ itemId: lcd, qty: 1 }] },
        a.cashierId,
      ),
      'PERMISSION_DENIED',
    );
  });

  test('a store cannot send to itself', async () => {
    const { a } = await twoStores(7304);
    const lcd = await addItem(a, 'LCD A', 3);
    await expectRefused(
      a.runInventory(
        'sendTransfer',
        { toStoreId: a.storeId, note: null, lines: [{ itemId: lcd, qty: 1 }] },
        a.storeOwnerId,
      ),
      'VALIDATION_FAILED',
    );
  });

  test('the transfer ops and the stock that left reach the other store; the rest stays home', () => {
    const ops = inventoryModule.operations;
    expect(ops['inventory.transfer_sent']?.otherStore?.({ toStoreId: 'b' })).toBe('b');
    expect(ops['inventory.transfer_received']?.otherStore?.({ fromStoreId: 'a' })).toBe('a');
    expect(ops['inventory.transfer_cancelled']?.otherStore?.({ toStoreId: 'b' })).toBe('b');
    expect(ops['inventory.transfer_settled']?.otherStore?.({ toStoreId: 'b' })).toBe('b');
    const sink = { id: 'x', label: 'TR-K7Q-0001' };
    expect(
      ops['inventory.stock_sent']?.otherStore?.({
        sink: { kind: 'transfer', toStoreId: 'b', ...sink },
      }),
    ).toBe('b');
    expect(
      ops['inventory.stock_sent']?.otherStore?.({ sink: { kind: 'transfer_settlement', ...sink } }),
    ).toBeNull();
    expect(ops['inventory.stock_received']?.otherStore).toBeUndefined();
  });
});

describe('receiving', () => {
  test('a short arrival: what came is in stock, the rest stays "Belum sampai" on both sides', async () => {
    const { a, b, sync, lcd, battery, transferId } = await sent(7311);
    await b.runInventory(
      'receiveTransfer',
      {
        transferId,
        lines: [
          { itemId: lcd, qty: 3 },
          { itemId: battery, qty: 2 },
        ],
        note: null,
      },
      b.storeOwnerId,
    );
    await sync(b, a);
    expect(await onHand(b, lcd)).toBe(3);
    expect(await onHand(b, battery)).toBe(2);
    expect(await onHand(a, lcd)).toBe(5);
    for (const phone of [a, b]) {
      const row = await transfer(phone, transferId);
      expect(row.stage).toBe('partial');
      expect(row.missingQty).toBe(2);
      expect(row.arrivals).toHaveLength(1);
    }
    expect((await transfer(a, transferId)).can.cancel).toBe(false);
  });

  test('never more than was sent, however it is split', async () => {
    const { b, lcd, transferId } = await sent(7312);
    await b.runInventory(
      'receiveTransfer',
      { transferId, lines: [{ itemId: lcd, qty: 4 }], note: null },
      b.storeOwnerId,
    );
    await expectRefused(
      b.runInventory(
        'receiveTransfer',
        { transferId, lines: [{ itemId: lcd, qty: 2 }], note: null },
        b.storeOwnerId,
      ),
      'VALIDATION_FAILED',
    );
    // A tampered phone sending the arrival anyway is refused by the rule.
    const arrival = await lastOp(b, 'inventory.transfer_received');
    await expectRefused(
      b.checkRule({
        ...arrival,
        id: '01920000-0000-7000-8000-00000000f001',
        entityId: '01920000-0000-7000-8000-00000000f002',
        payload: { ...arrival.payload, lines: [{ itemId: lcd, qty: 2 }] },
      }),
      'VALIDATION_FAILED',
      'inventory.refusal.moreThanSent',
    );
  });

  test('stock comes in only as the arrival lists it', async () => {
    const { b, lcd, transferId } = await sent(7313);
    await b.runInventory(
      'receiveTransfer',
      { transferId, lines: [{ itemId: lcd, qty: 1 }], note: null },
      b.storeOwnerId,
    );
    const movement = await lastOp(b, 'inventory.stock_received');
    await expectRefused(
      b.checkRule({
        ...movement,
        id: '01920000-0000-7000-8000-00000000f003',
        entityId: '01920000-0000-7000-8000-00000000f004',
        payload: { ...movement.payload, qty: 5 },
      }),
      'VALIDATION_FAILED',
      'inventory.refusal.transferMismatch',
    );
  });

  test('the sending store cannot record the arrival', async () => {
    const { a, lcd, transferId } = await sent(7314);
    await expectRefused(
      a.runInventory(
        'receiveTransfer',
        { transferId, lines: [{ itemId: lcd, qty: 1 }], note: null },
        a.storeOwnerId,
      ),
      'VALIDATION_FAILED',
    );
  });
});

describe('stock leaves only as the transfer lists it', () => {
  test('a forged send of more than the transfer lists is refused', async () => {
    const { a, lcd } = await sent(7321);
    const movement = await lastOp(a, 'inventory.stock_sent');
    const forged = {
      ...movement,
      id: '01920000-0000-7000-8000-00000000f005',
      entityId: '01920000-0000-7000-8000-00000000f006',
    };
    // The same send again is a second movement for one line.
    await expectRefused(
      a.checkRule(forged),
      'VALIDATION_FAILED',
      'inventory.refusal.alreadyRecorded',
    );
    await expectRefused(
      a.checkRule({ ...forged, payload: { ...movement.payload, itemId: lcd, qty: 1 } }),
      'VALIDATION_FAILED',
    );
  });
});

describe('only what left the sender can arrive', () => {
  test('a transfer whose stock never left (a send without its movements) cannot be received', async () => {
    const stores = await twoStores(7322);
    const { a, b, sync } = stores;
    const lcd = await addItem(a, 'LCD Redmi Note 10 + frame', 10);
    const { transferId } = (await a.runInventory(
      'sendTransfer',
      { toStoreId: b.storeId, note: null, lines: [{ itemId: lcd, qty: 5 }] },
      a.storeOwnerId,
    )) as { transferId: string };
    // As a tampered phone would push it: the transfer, but not the stock leaving.
    await sync(a, b, (op) => op.type === 'inventory.stock_sent');
    const atB = await transfer(b, transferId);
    expect(atB.lines.map((line) => [line.listed, line.sent])).toEqual([[5, 0]]);
    expect(atB.can.receive).toBe(false);
    await expectRefused(
      b.runInventory(
        'receiveTransfer',
        { transferId, lines: [{ itemId: lcd, qty: 1 }], note: null },
        b.storeOwnerId,
      ),
      'VALIDATION_FAILED',
    );
    const arrival = await lastOp(b, 'inventory.transfer_received').catch(() => undefined);
    expect(arrival).toBeUndefined();
  });

  test('a send naming another store than its transfer is refused', async () => {
    const { a } = await sent(7323);
    const movement = await lastOp(a, 'inventory.stock_sent');
    const payload = movement.payload as { sink: Record<string, unknown> };
    await expectRefused(
      a.checkRule({
        ...movement,
        id: '01920000-0000-7000-8000-00000000f007',
        entityId: '01920000-0000-7000-8000-00000000f008',
        payload: {
          ...payload,
          sink: { ...payload.sink, toStoreId: '01920000-0000-7000-8000-00000000c0c0' },
        },
      }),
      'VALIDATION_FAILED',
      'inventory.refusal.transferMismatch',
    );
  });
});

describe('settling what did not arrive', () => {
  test('back into the sender’s stock, or written off with a reason', async () => {
    const { a, b, sync, lcd, battery, transferId } = await sent(7331);
    await b.runInventory(
      'receiveTransfer',
      {
        transferId,
        lines: [
          { itemId: lcd, qty: 3 },
          { itemId: battery, qty: 2 },
        ],
        note: null,
      },
      b.storeOwnerId,
    );
    await sync(b, a);
    await expectRefused(
      a.runInventory(
        'settleTransfer',
        { transferId, reason: null, lines: [{ itemId: lcd, outcome: 'lost', qty: 1 }] },
        a.storeOwnerId,
      ),
      'VALIDATION_FAILED',
    );
    await expectRefused(
      a.runInventory(
        'settleTransfer',
        { transferId, reason: null, lines: [{ itemId: lcd, outcome: 'back', qty: 3 }] },
        a.storeOwnerId,
      ),
      'VALIDATION_FAILED',
    );
    await a.runInventory(
      'settleTransfer',
      {
        transferId,
        reason: 'Satu pecah di jalan',
        lines: [
          { itemId: lcd, outcome: 'back', qty: 1 },
          { itemId: lcd, outcome: 'lost', qty: 1 },
        ],
      },
      a.storeOwnerId,
    );
    await sync(a, b);
    expect(await onHand(a, lcd)).toBe(6);
    for (const phone of [a, b]) {
      const row = await transfer(phone, transferId);
      expect(row.stage).toBe('done');
      expect(row.settlements[0]?.reason).toBe('Satu pecah di jalan');
    }
  });

  test('only an owner settles; a manager with sending rights cannot write parts off', async () => {
    const { a, b, sync, lcd, transferId } = await sent(7332);
    await b.runInventory(
      'receiveTransfer',
      { transferId, lines: [{ itemId: lcd, qty: 4 }], note: null },
      b.storeOwnerId,
    );
    await sync(b, a);
    await expectRefused(
      a.runInventory(
        'settleTransfer',
        { transferId, reason: 'Hilang', lines: [{ itemId: lcd, outcome: 'lost', qty: 1 }] },
        a.managerId,
      ),
      'PERMISSION_DENIED',
    );
  });

  test('a written-off part that turns up after all can still be received, and reads over', async () => {
    const { a, b, sync, lcd, battery, transferId } = await sent(7333);
    await b.runInventory(
      'receiveTransfer',
      {
        transferId,
        lines: [
          { itemId: lcd, qty: 4 },
          { itemId: battery, qty: 2 },
        ],
        note: null,
      },
      b.storeOwnerId,
    );
    await sync(b, a);
    await a.runInventory(
      'settleTransfer',
      {
        transferId,
        reason: 'Tidak ada di paket',
        lines: [{ itemId: lcd, outcome: 'lost', qty: 1 }],
      },
      a.storeOwnerId,
    );
    await sync(a, b);
    expect((await transfer(b, transferId)).can.receive).toBe(true);
    await b.runInventory(
      'receiveTransfer',
      { transferId, lines: [{ itemId: lcd, qty: 1 }], note: 'Terselip di kardus' },
      b.storeOwnerId,
    );
    await sync(b, a);
    expect((await transfer(a, transferId)).stage).toBe('over');
    await a.runInventory(
      'settleTransfer',
      { transferId, reason: null, lines: [{ itemId: lcd, outcome: 'arrived', qty: 1 }] },
      a.storeOwnerId,
    );
    // It undoes the write-off: the part never came back to A, so A's stock does not drop again.
    expect(await onHand(a, lcd)).toBe(5);
    const row = await transfer(a, transferId);
    expect(row.stage).toBe('done');
    expect(row.settlements[0]?.lines).toEqual([
      expect.objectContaining({ itemId: lcd, outcome: 'found', qty: 1 }),
    ]);
  });
});

describe('cancelling', () => {
  test('before anything arrives every part goes back to the sender', async () => {
    const { a, b, sync, lcd, battery, transferId } = await sent(7341);
    await a.runInventory('cancelTransfer', { transferId, reason: 'Salah toko' }, a.storeOwnerId);
    await sync(a, b);
    expect(await onHand(a, lcd)).toBe(10);
    expect(await onHand(a, battery)).toBe(4);
    for (const phone of [a, b]) expect((await transfer(phone, transferId)).stage).toBe('cancelled');
    await expectRefused(
      b.runInventory(
        'receiveTransfer',
        { transferId, lines: [{ itemId: lcd, qty: 1 }], note: null },
        b.storeOwnerId,
      ),
      'VALIDATION_FAILED',
    );
  });

  test('once something arrived it cannot be cancelled', async () => {
    const { a, b, sync, lcd, transferId } = await sent(7342);
    await b.runInventory(
      'receiveTransfer',
      { transferId, lines: [{ itemId: lcd, qty: 1 }], note: null },
      b.storeOwnerId,
    );
    await sync(b, a);
    await expectRefused(
      a.runInventory('cancelTransfer', { transferId, reason: null }, a.storeOwnerId),
      'VALIDATION_FAILED',
    );
  });

  test('an arrival recorded offline before the cancel stands; the owner settles it as arrived', async () => {
    const { a, b, sync, lcd, battery, transferId } = await sent(7343);
    // B counts the box in while offline; A cancels later, not knowing.
    await b.runInventory(
      'receiveTransfer',
      {
        transferId,
        lines: [
          { itemId: lcd, qty: 5 },
          { itemId: battery, qty: 2 },
        ],
        note: null,
      },
      b.storeOwnerId,
    );
    a.advance(b.now() - a.now() + 60_000);
    await a.runInventory('cancelTransfer', { transferId, reason: 'Batal' }, a.storeOwnerId);
    expect(await onHand(a, lcd)).toBe(10);
    // The arrival is judged against A's records after the cancel, as the server would.
    const arrival = await lastOp(b, 'inventory.transfer_received');
    await a.checkRule(arrival);
    await sync(b, a);
    await sync(a, b);
    for (const phone of [a, b]) expect((await transfer(phone, transferId)).stage).toBe('over');
    expect(await onHand(b, lcd)).toBe(5);

    await a.runInventory(
      'settleTransfer',
      {
        transferId,
        reason: null,
        lines: [
          { itemId: lcd, outcome: 'arrived', qty: 5 },
          { itemId: battery, outcome: 'arrived', qty: 2 },
        ],
      },
      a.storeOwnerId,
    );
    await sync(a, b);
    // The parts are at B: A's stock drops again, and nothing was made out of thin air.
    expect(await onHand(a, lcd)).toBe(5);
    expect(await onHand(a, battery)).toBe(2);
    for (const phone of [a, b]) {
      const row = await transfer(phone, transferId);
      expect(row.stage).toBe('cancelled');
      expect(row.missingQty).toBe(0);
    }
  });

  test('an arrival recorded after the cancel (by the phone’s clock) is refused', async () => {
    const { a, b, sync, lcd, transferId } = await sent(7344);
    await a.runInventory('cancelTransfer', { transferId, reason: null }, a.storeOwnerId);
    // B's phone did not hear of the cancel and receives later by its clock.
    b.advance(a.now() - b.now() + 10 * 60_000);
    await b.runInventory(
      'receiveTransfer',
      { transferId, lines: [{ itemId: lcd, qty: 5 }], note: null },
      b.storeOwnerId,
    );
    const arrival = await lastOp(b, 'inventory.transfer_received');
    await sync(a, b);
    // Judged on A's side, where the cancel is.
    await expectRefused(
      a.checkRule(arrival),
      'INVALID_TRANSITION',
      'inventory.refusal.transferCancelled',
    );
  });
});
