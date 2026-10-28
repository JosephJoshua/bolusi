// Cancelling a servisan through the real runtime: only owners may cancel (counter staff kept
// customers' cash by cancelling), each store's two cancellation fees, the fee a cancel charged
// beside the store's fee then, and the owners' list of cancels, also as folded on another device.
import { sql } from 'kysely';
import { afterEach, describe, expect, test } from 'vitest';

import { DomainError } from '@bolusi/core';

import { storeCancelFeesChangedApplier } from '../src/repair/applier.js';
import { REPAIR_OP } from '../src/repair/constants.js';
import { repairOperations, ticketCancelledPayload } from '../src/repair/operations.js';

import {
  accessoriesBack,
  intake,
  openRepairHarness,
  type RepairHarness,
} from './support/repair-harness.js';

const open: RepairHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function harness(seed: number): Promise<RepairHarness> {
  const h = await openRepairHarness(seed);
  open.push(h);
  return h;
}

/** A second device in the same store, with the same people. */
async function peer(a: RepairHarness, seed: number): Promise<RepairHarness> {
  const b = await openRepairHarness(seed, {
    tenantId: a.tenantId,
    storeId: a.storeId,
    users: [a.cashierId, a.technicianId, a.technician2Id, a.zeroUserId, a.ownerId, a.storeOwnerId],
  });
  open.push(b);
  return b;
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

async function openTicket(h: RepairHarness): Promise<string> {
  const { ticketId } = (await h.run('openTicket', intake(h), h.cashierId)) as { ticketId: string };
  return ticketId;
}

async function ticket(h: RepairHarness, ticketId: string) {
  return (await h.query('getTicket', { ticketId }, h.cashierId)).rows[0];
}

const FEES = { beforeWork: 10_000, afterWork: 50_000 };

describe('who may cancel', () => {
  test('a cashier and a technician are refused; a store owner and the owner may cancel', async () => {
    const h = await harness(5101);
    const first = await openTicket(h);
    const second = await openTicket(h);
    for (const userId of [h.cashierId, h.technicianId, h.zeroUserId]) {
      await expectCode(
        h.run('cancelTicket', { ticketId: first, reason: 'Batal', fee: 0 }, userId),
        'PERMISSION_DENIED',
      );
    }
    expect((await ticket(h, first)).outcome).toBe('received');

    await h.run('cancelTicket', { ticketId: first, reason: 'Batal', fee: 0 }, h.storeOwnerId);
    await h.run('cancelTicket', { ticketId: second, reason: 'Batal', fee: 0 }, h.ownerId);
    expect((await ticket(h, first)).outcome).toBe('cancelled');
    expect((await ticket(h, second)).cancelledBy).toBe(h.ownerId);
  });

  test('a repaired phone can still be cancelled until it is handed back', async () => {
    const h = await harness(5102);
    const ticketId = await openTicket(h);
    await h.run('startWork', { ticketId, beforePhotos: [h.photo(1)] }, h.technicianId);
    await h.run('markRepaired', { ticketId, afterPhotos: [h.photo(2)] }, h.technicianId);
    await h.run(
      'cancelTicket',
      { ticketId, reason: 'Pelanggan tidak mau bayar', fee: 0 },
      h.storeOwnerId,
    );
    expect(await ticket(h, ticketId)).toMatchObject({ outcome: 'cancelled', location: 'in_store' });

    const returned = await openTicket(h);
    await h.run('cancelTicket', { ticketId: returned, reason: 'Batal', fee: 0 }, h.storeOwnerId);
    await h.run(
      'returnDevice',
      {
        ticketId: returned,
        handoverPhoto: h.photo(3),
        signature: h.photo(4),
        checklist: accessoriesBack(),
      },
      h.cashierId,
    );
    await expectCode(
      h.run('cancelTicket', { ticketId: returned, reason: 'lagi', fee: 0 }, h.storeOwnerId),
      'INVALID_TRANSITION',
    );
  });
});

describe('the store’s cancellation fees', () => {
  test('a store charges nothing until its owner sets the fees; a cashier cannot set them', async () => {
    const h = await harness(5103);
    expect((await h.query('cancelFees', {}, h.cashierId)).rows[0]).toStrictEqual({
      beforeWork: 0,
      afterWork: 0,
    });
    await expectCode(h.run('setCancelFees', FEES, h.cashierId), 'PERMISSION_DENIED');
    await expectCode(h.run('setCancelFees', FEES, h.technicianId), 'PERMISSION_DENIED');

    await h.run('setCancelFees', FEES, h.storeOwnerId);
    expect((await h.query('cancelFees', {}, h.cashierId)).rows[0]).toStrictEqual(FEES);
    await expectCode(h.run('setCancelFees', FEES, h.ownerId), 'VALIDATION_FAILED');
  });

  test('a fee is whole rupiah, never negative, never above the price cap', async () => {
    const h = await harness(5104);
    for (const bad of [
      { beforeWork: -1, afterWork: 0 },
      { beforeWork: 0, afterWork: 1.5 },
      { beforeWork: 0, afterWork: 1_000_000_000_001 },
    ]) {
      await expectCode(h.run('setCancelFees', bad, h.storeOwnerId), 'VALIDATION_FAILED');
    }
    const ticketId = await openTicket(h);
    await expectCode(
      h.run('cancelTicket', { ticketId, reason: 'Batal', fee: -5_000 }, h.storeOwnerId),
      'VALIDATION_FAILED',
    );
    // The signed payload refuses a negative fee too, so no other client can record one.
    const v2 = ticketCancelledPayload;
    expect(repairOperations[REPAIR_OP.ticketCancelled]!.payload).toBe(v2);
    expect(v2.safeParse({ reason: 'x', fee: -1, standardFee: 0 }).success).toBe(false);
    expect(v2.safeParse({ reason: 'x', fee: 0 }).success).toBe(false);
  });
});

describe('what a cancel charges', () => {
  test('the before-work fee applies until work has ever started, then the after-work fee', async () => {
    const h = await harness(5105);
    await h.run('setCancelFees', FEES, h.storeOwnerId);

    const fresh = await openTicket(h);
    expect((await ticket(h, fresh)).workStarted).toBe(false);
    await h.run('cancelTicket', { ticketId: fresh, reason: 'Batal', fee: 10_000 }, h.storeOwnerId);

    // Paused for parts after starting: work has started, so the after-work fee is the store's.
    const paused = await openTicket(h);
    await h.run('startWork', { ticketId: paused, beforePhotos: [h.photo(1)] }, h.technicianId);
    await h.run('markWaitingForParts', { ticketId: paused, note: 'LCD' }, h.technicianId);
    expect((await ticket(h, paused)).workStarted).toBe(true);
    await h.run('cancelTicket', { ticketId: paused, reason: 'Batal', fee: 50_000 }, h.storeOwnerId);

    expect(await ticket(h, fresh)).toMatchObject({
      outcome: 'cancelled',
      outcomeNote: 'Batal',
      cancelFee: 10_000,
      cancelStandardFee: 10_000,
      cancelledBy: h.storeOwnerId,
    });
    expect(await ticket(h, paused)).toMatchObject({ cancelFee: 50_000, cancelStandardFee: 50_000 });
  });

  test('a cancel that leaves the fee alone charges the store’s fee as it is when cancelling', async () => {
    const h = await harness(5107);
    await h.run('setCancelFees', FEES, h.storeOwnerId);
    const fresh = await openTicket(h);
    const started = await openTicket(h);
    await h.run('startWork', { ticketId: started, beforePhotos: [h.photo(1)] }, h.technicianId);

    await h.run('cancelTicket', { ticketId: fresh, reason: 'Batal' }, h.storeOwnerId);
    await h.run('cancelTicket', { ticketId: started, reason: 'Batal' }, h.storeOwnerId);

    expect(await ticket(h, fresh)).toMatchObject({ cancelFee: 10_000, cancelStandardFee: 10_000 });
    expect(await ticket(h, started)).toMatchObject({
      cancelFee: 50_000,
      cancelStandardFee: 50_000,
    });
  });

  test('a changed fee is recorded beside the store’s, and changing the store’s later leaves it', async () => {
    const h = await harness(5106);
    await h.run('setCancelFees', FEES, h.storeOwnerId);
    const ticketId = await openTicket(h);
    await h.run('startWork', { ticketId, beforePhotos: [h.photo(1)] }, h.technicianId);
    await h.run(
      'cancelTicket',
      { ticketId, reason: 'Sparepart tidak ada, biaya dibebaskan', fee: 0 },
      h.storeOwnerId,
    );
    await h.run('setCancelFees', { beforeWork: 0, afterWork: 75_000 }, h.storeOwnerId);

    const row = await ticket(h, ticketId);
    expect(row).toMatchObject({ cancelFee: 0, cancelStandardFee: 50_000 });
    const event = row.events.find((e: { kind: string }) => e.kind === REPAIR_OP.ticketCancelled);
    expect(event.detail).toStrictEqual({
      reason: 'Sparepart tidak ada, biaya dibebaskan',
      fee: 0,
      standardFee: 50_000,
    });
  });
});

describe('the owners’ list of cancels', () => {
  test('lists only cancelled tickets, latest cancel first, with fee and who', async () => {
    const h = await harness(5107);
    const older = await openTicket(h);
    const newer = await openTicket(h);
    await openTicket(h); // still open: never listed
    // The newer ticket is cancelled first, so the cancel order is not the intake order.
    await h.run('cancelTicket', { ticketId: newer, reason: 'A', fee: 5_000 }, h.storeOwnerId);
    await h.run('cancelTicket', { ticketId: older, reason: 'B', fee: 0 }, h.ownerId);

    const page = await h.query(
      'listTickets',
      { filter: { outcomes: ['cancelled'] }, sort: 'cancelledAt.desc', limit: 1 },
      h.storeOwnerId,
    );
    expect(page.rows.map((r: { id: string }) => r.id)).toEqual([older]);
    expect(page.rows[0]).toMatchObject({ cancelFee: 0, cancelledBy: h.ownerId, outcomeNote: 'B' });
    const next = await h.query(
      'listTickets',
      {
        filter: { outcomes: ['cancelled'] },
        sort: 'cancelledAt.desc',
        limit: 1,
        cursor: page.nextCursor,
      },
      h.storeOwnerId,
    );
    expect(next.rows.map((r: { id: string }) => r.id)).toEqual([newer]);
    expect(next.nextCursor).toBeNull();
  });
});

describe('folding on another device', () => {
  test('fees and cancels fold to the same rows elsewhere, also on rebuild', async () => {
    const a = await harness(5108);
    await a.run('setCancelFees', FEES, a.storeOwnerId);
    const ticketId = await openTicket(a);
    await a.run('cancelTicket', { ticketId, reason: 'Batal', fee: 7_500 }, a.storeOwnerId);
    const ops = await a.ownOps();

    const b = await peer(a, 5109);
    let arrival = 1;
    for (const op of ops) await b.deliverPulled(op, arrival++);
    const read = async (h: RepairHarness) => ({
      fees: (await h.query('cancelFees', {}, h.cashierId)).rows[0],
      ticket: await ticket(h, ticketId),
    });
    const expected = await read(a);
    expect(await read(b)).toStrictEqual(expected);
    await b.engine.rebuild('repair');
    expect(await read(b)).toStrictEqual(expected);
    expect(expected.ticket).toMatchObject({ cancelFee: 7_500, cancelStandardFee: 10_000 });
  });

  test('a cancel an older app signed (schema v1) folds as charging nothing', async () => {
    const a = await harness(5110);
    const ticketId = await openTicket(a);
    await a.run('cancelTicket', { ticketId, reason: 'Batal', fee: 0 }, a.storeOwnerId);
    const ops = await a.ownOps();
    const v2 = ops.find((op) => op.type === REPAIR_OP.ticketCancelled)!;
    const v1 = { ...v2, schemaVersion: 1, payload: { reason: 'Batal' } };

    const b = await peer(a, 5111);
    let arrival = 1;
    for (const op of ops) await b.deliverPulled(op === v2 ? (v1 as never) : op, arrival++);
    expect(await ticket(b, ticketId)).toMatchObject({
      outcome: 'cancelled',
      cancelFee: null,
      cancelStandardFee: null,
      cancelledBy: a.storeOwnerId,
      cancelledAt: v2.timestamp,
    });
  });

  test('a price change an older app signed unagreed (schema v1) still counts, as it did then', async () => {
    const a = await harness(5113);
    const ticketId = await openTicket(a);
    await a.run(
      'changeQuote',
      {
        ticketId,
        kind: 'part',
        description: 'Lem',
        amount: 20_000,
        reason: 'Lepas',
        customerAgreed: true,
      },
      a.cashierId,
    );
    const ops = await a.ownOps();
    const v2 = ops.find((op) => op.type === REPAIR_OP.quoteChanged)!;
    const v1Payload: Record<string, unknown> = { ...(v2.payload as object), customerAgreed: false };
    delete v1Payload['waitsForCustomer'];
    const v1 = { ...v2, schemaVersion: 1, payload: v1Payload };

    const b = await peer(a, 5114);
    let arrival = 1;
    for (const op of ops) await b.deliverPulled(op === v2 ? (v1 as never) : op, arrival++);
    const row = await ticket(b, ticketId);
    expect(row.quoteTotal).toBe(770_000);
    expect(row.pendingProposals).toBe(0);
  });

  test('a fees op whose entity is not its own store is ignored by the fold', async () => {
    const h = await harness(5112);
    await h.run('setCancelFees', FEES, h.storeOwnerId);
    const [changed] = await h.ownOps();
    await storeCancelFeesChangedApplier(h.db as never, {
      ...changed!,
      entityId: '01920000-0000-7000-8000-00000000beef',
      payload: { beforeWork: 1, afterWork: 1 },
    });
    expect((await h.query('cancelFees', {}, h.cashierId)).rows[0]).toStrictEqual(FEES);
    const n = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM repair_store_cancel_fees`.execute(
      h.db,
    );
    expect(n.rows[0]!.n).toBe(1);
  });
});
