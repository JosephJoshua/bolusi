// Batalkan: a status or technician slip is taken back by one recorded, server-checked op that puts
// the servisan back as it was before the slip's command.
import { afterEach, describe, expect, test } from 'vitest';

import { DomainError, refusalKeyOf } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import { REPAIR_UNDO_GRACE_MS } from '../src/repair/constants.js';

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

async function opened(h: RepairHarness): Promise<string> {
  const { ticketId } = (await h.run('openTicket', intake(h), h.cashierId)) as { ticketId: string };
  return ticketId;
}

async function ticketOf(h: RepairHarness, ticketId: string) {
  return (await h.query('getTicket', { ticketId }, h.ownerId)).rows[0];
}

async function lastOp(h: RepairHarness): Promise<SignedOperation> {
  return (await h.ownOps()).at(-1)!;
}

async function refusal(p: Promise<unknown>): Promise<string | null> {
  const err = await p.then(
    () => new Error('expected a refusal, but the call resolved'),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  return refusalKeyOf(err);
}

describe('taking back a slip', () => {
  test('a first start goes back to received, with nobody on it and no start counted', async () => {
    const h = await harness(901);
    const ticketId = await opened(h);
    await h.run('startWork', { ticketId, beforePhotos: [h.photo(1)] }, h.technicianId);
    await h.run('undoChange', { ticketId, change: 'repair.work_started' }, h.technicianId);
    const ticket = await ticketOf(h, ticketId);
    expect(ticket.outcome).toBe('received');
    expect(ticket.technicianId).toBeNull();
    expect(ticket.workStarted).toBe(false);
    // The history keeps the slip and its undo.
    expect(ticket.events.map((e: { kind: string }) => e.kind).slice(-2)).toStrictEqual([
      'repair.work_started',
      'repair.change_reverted',
    ]);
  });

  test('waiting for parts goes back to in repair, without the note', async () => {
    const h = await harness(911);
    const ticketId = await opened(h);
    await h.run('startWork', { ticketId, beforePhotos: [h.photo(1)] }, h.technicianId);
    await h.run('markWaitingForParts', { ticketId, note: 'LCD' }, h.technicianId);
    await h.run('undoChange', { ticketId, change: 'repair.work_paused' }, h.technicianId);
    const ticket = await ticketOf(h, ticketId);
    expect(ticket.outcome).toBe('in_repair');
    expect(ticket.outcomeNote).toBeNull();
    expect(ticket.technicianId).toBe(h.technicianId);
  });

  test('marked repaired goes back to in repair, not ready and without its note', async () => {
    const h = await harness(921);
    const ticketId = await opened(h);
    await h.run('startWork', { ticketId, beforePhotos: [h.photo(1)] }, h.technicianId);
    await h.run('markWaitingForParts', { ticketId, note: 'LCD' }, h.technicianId);
    await h.run('startWork', { ticketId }, h.technicianId);
    await h.run(
      'markRepaired',
      { ticketId, afterPhotos: [h.photo(2)], note: 'Ganti LCD' },
      h.technicianId,
    );
    await h.run('undoChange', { ticketId, change: 'repair.marked_repaired' }, h.technicianId);
    const ticket = await ticketOf(h, ticketId);
    expect(ticket.outcome).toBe('in_repair');
    expect(ticket.outcomeNote).toBeNull();
    expect(ticket.readyAt).toBeNull();
  });

  test('a technician assigned by mistake gives the work back to the one before', async () => {
    const h = await harness(931);
    const ticketId = await opened(h);
    await h.run('claimTicket', { ticketId }, h.technicianId);
    await h.run('assignTechnician', { ticketId, technicianId: h.technician2Id }, h.ownerId);
    await h.run('undoChange', { ticketId, change: 'repair.technician_assigned' }, h.ownerId);
    expect((await ticketOf(h, ticketId)).technicianId).toBe(h.technicianId);
  });

  test('the customer’s page leaves the slip out', async () => {
    const h = await harness(941);
    const ticketId = await opened(h);
    await h.run('startWork', { ticketId, beforePhotos: [h.photo(1)] }, h.technicianId);
    await h.run('undoChange', { ticketId, change: 'repair.work_started' }, h.technicianId);
    const { readCustomerStatus } = await import('../src/repair/customer-status.js');
    const read = await readCustomerStatus(
      h.db as never,
      { tenantId: h.tenantId, storeId: h.storeId, ticketId },
      'Toko',
      h.now(),
    );
    expect(read.kind === 'found' && read.status.steps.map((s) => s.step)).toStrictEqual([
      'received',
    ]);
  });
});

describe('what the server refuses', () => {
  test('a change that is no longer the latest one', async () => {
    const h = await harness(951);
    const ticketId = await opened(h);
    await h.run('startWork', { ticketId, beforePhotos: [h.photo(1)] }, h.technicianId);
    await h.run('markWaitingForParts', { ticketId, note: '' }, h.technicianId);
    expect(
      await refusal(
        h.run('undoChange', { ticketId, change: 'repair.work_started' }, h.technicianId),
      ),
    ).toBe('repair.refusal.undoChangedSince');
  });

  test('someone else’s change, a late undo, an undo of an undo, and one without the permission', async () => {
    const h = await harness(961);
    const ticketId = await opened(h);
    await h.run('startWork', { ticketId, beforePhotos: [h.photo(1)] }, h.technicianId);
    const last = await lastOp(h);
    const started = (await h.ownOps()).filter((op) => op.timestamp === last.timestamp);
    const undo = (userId: string, timestamp: number, undoes = started.map((op) => op.id)) =>
      ({
        ...started.at(-1)!,
        id: '01900000-0000-7000-8000-00000000abcd',
        type: 'repair.change_reverted',
        userId,
        timestamp,
        payload: { undoes },
      }) as SignedOperation;
    const at = started.at(-1)!.timestamp;
    expect(started.map((op) => op.type)).toStrictEqual([
      'repair.ticket_claimed',
      'repair.work_photos_added',
      'repair.work_started',
    ]);

    expect(refusalKeyOf(await h.checkRule(undo(h.technician2Id, at + 1)).catch((e) => e))).toBe(
      'repair.refusal.undoNotYours',
    );
    expect(
      refusalKeyOf(
        await h.checkRule(undo(h.technicianId, at + REPAIR_UNDO_GRACE_MS + 1)).catch((e) => e),
      ),
    ).toBe('repair.refusal.undoExpired');
    expect(
      refusalKeyOf(
        await h
          .checkRule(undo(h.technicianId, at + 1), undefined, {
            holdsPermission: () => Promise.resolve(false),
          })
          .catch((e) => e),
      ),
    ).toBe('repair.refusal.undoChangedSince');
    await expect(h.checkRule(undo(h.technicianId, at + 1))).resolves.toBeUndefined();

    await h.run('undoChange', { ticketId, change: 'repair.work_started' }, h.technicianId);
    const undone = await lastOp(h);
    expect(
      refusalKeyOf(
        await h.checkRule(undo(h.technicianId, undone.timestamp + 1, [undone.id])).catch((e) => e),
      ),
    ).toBe('repair.refusal.undoChangedSince');
  });

  test('a cancelled servisan keeps its cancel', async () => {
    const h = await harness(971);
    const ticketId = await opened(h);
    await h.run('startWork', { ticketId, beforePhotos: [h.photo(1)] }, h.technicianId);
    const started = await lastOp(h);
    await h.run('cancelTicket', { ticketId, reason: 'Batal' }, h.storeOwnerId);
    const undo = {
      ...started,
      id: '01900000-0000-7000-8000-00000000abce',
      type: 'repair.change_reverted',
      timestamp: started.timestamp + 1,
      payload: { undoes: [started.id] },
    } as SignedOperation;
    expect(await h.checkRule(undo).catch((e: unknown) => refusalKeyOf(e))).toBe(
      'repair.refusal.cancelled',
    );
  });
});

test('another device folds the undo to the same servisan', async () => {
  const h = await harness(981);
  const other = await openRepairHarness(982, {
    tenantId: h.tenantId,
    storeId: h.storeId,
    users: [h.cashierId, h.technicianId, h.technician2Id, h.zeroUserId, h.ownerId, h.storeOwnerId],
  });
  open.push(other);
  const ticketId = await opened(h);
  await h.run('startWork', { ticketId, beforePhotos: [h.photo(1)] }, h.technicianId);
  await h.run('markWaitingForParts', { ticketId, note: 'LCD' }, h.technicianId);
  await h.run('undoChange', { ticketId, change: 'repair.work_paused' }, h.technicianId);
  let n = 0;
  for (const op of await h.ownOps()) await other.deliverPulled(op, (n += 1));
  const here = await ticketOf(h, ticketId);
  const there = await ticketOf(other, ticketId);
  expect(there.outcome).toBe('in_repair');
  expect([there.outcome, there.outcomeNote, there.technicianId, there.readyAt]).toStrictEqual([
    here.outcome,
    here.outcomeNote,
    here.technicianId,
    here.readyAt,
  ]);
});
