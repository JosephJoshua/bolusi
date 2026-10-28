// What the server checks of a pushed repair op that the device's command could not be trusted with:
// a repair type's terms against the owner's list, the intake photos the store asks for.
//
// Each test writes ops through a real device, then judges one (as is, or as a tampered device would
// sign it) by its rule against a second device standing in for the server, which holds every op
// that arrived before it.
import { afterEach, describe, expect, test } from 'vitest';

import { refusalKeyOf } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import { REPAIR_OP } from '../src/repair/constants.js';
import { DEFAULT_INTAKE_OPTIONS } from '../src/repair/intake-options.js';

import { intake, openRepairHarness, type RepairHarness } from './support/repair-harness.js';

const open: RepairHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function devices(seed: number) {
  const h = await openRepairHarness(seed);
  const server = await openRepairHarness(seed + 50, {
    tenantId: h.tenantId,
    storeId: h.storeId,
    users: [h.cashierId, h.technicianId, h.technician2Id, h.zeroUserId, h.ownerId, h.storeOwnerId],
  });
  open.push(h, server);
  let arrival = 0;
  const delivered = new Set<string>();
  /** The server folds every op of `h` it has not had yet, except `skip`. */
  const sync = async (...skip: readonly SignedOperation[]): Promise<void> => {
    for (const op of await h.ownOps()) {
      if (delivered.has(op.id) || skip.some((s) => s.id === op.id)) continue;
      delivered.add(op.id);
      await server.deliverPulled(op, (arrival += 1));
    }
  };
  /** The server's refusal key for `op`, or null when it would accept it. */
  const verdict = async (op: SignedOperation): Promise<string | null> =>
    server.checkRule(op).then(
      () => null,
      (error: unknown) => refusalKeyOf(error) ?? String(error),
    );
  /** The last op of `type` `h` wrote. */
  const last = async (type: string): Promise<SignedOperation> =>
    (await h.ownOps()).filter((op) => op.type === type).at(-1)!;
  return { h, server, sync, verdict, last };
}

/** `op` as a tampered device would sign it: the same op with `payload` changed. */
function tampered(op: SignedOperation, payload: Record<string, unknown>): SignedOperation {
  return { ...op, payload: { ...(op.payload as Record<string, unknown>), ...payload } } as never;
}

const repairTypesList = (screenDays: number) =>
  DEFAULT_INTAKE_OPTIONS.repairTypes.map((type) => ({
    id: type.id,
    label: type.label,
    warrantyDays: type.id === 'screen' ? screenDays : type.warrantyDays,
    needsVideo: type.needsVideo,
  }));

describe('repair types carry the owner’s terms, not the device’s', () => {
  test('an intake whose type terms differ from the owner’s list is refused', async () => {
    const { h, sync, verdict, last } = await devices(7101);
    await h.run('openTicket', intake(h, { repairTypes: ['screen'] }), h.cashierId);
    const opened = await last(REPAIR_OP.ticketOpened);
    await sync(opened);

    expect(await verdict(opened)).toBeNull();
    const longer = tampered(opened, {
      repairTypes: [{ item: 'screen', label: null, warrantyDays: 365, needsVideo: false }],
    });
    expect(await verdict(longer)).toBe('repair.refusal.repairTypeTerms');
    // An unlock without its video, by claiming the type needs none.
    const noVideo = tampered(opened, {
      repairTypes: [{ item: 'unlock', label: null, warrantyDays: 0, needsVideo: false }],
    });
    expect(await verdict(noVideo)).toBe('repair.refusal.repairTypeTerms');
    const unknown = tampered(opened, {
      repairTypes: [{ item: 'teleport', label: 'Teleport', warrantyDays: 30, needsVideo: false }],
    });
    expect(await verdict(unknown)).toBe('repair.refusal.repairTypeTerms');
  });

  test('a list changed while the intake was offline: terms some version gave stand', async () => {
    const { h, sync, verdict, last } = await devices(7102);
    await h.run('openTicket', intake(h, { repairTypes: ['screen'] }), h.cashierId);
    const opened = await last(REPAIR_OP.ticketOpened);

    // The owner cut the screen warranty to 7 days, then removed unlocking, before the 30-day intake
    // reached the server: the counter promised what the list said then, and the phone is in.
    await h.run(
      'changeIntakeOptions',
      { list: 'repairTypes', items: repairTypesList(7) },
      h.ownerId,
    );
    await h.run(
      'changeIntakeOptions',
      { list: 'repairTypes', items: repairTypesList(7).filter((type) => type.id !== 'unlock') },
      h.ownerId,
    );
    await sync(opened);
    expect(await verdict(opened)).toBeNull();
    // Terms no version gave are still refused: more days than ever, or an unlock without video.
    const longer = tampered(opened, {
      repairTypes: [{ item: 'screen', label: null, warrantyDays: 31, needsVideo: false }],
    });
    expect(await verdict(longer)).toBe('repair.refusal.repairTypeTerms');
    const noVideo = tampered(opened, {
      repairTypes: [{ item: 'unlock', label: null, warrantyDays: 0, needsVideo: false }],
    });
    expect(await verdict(noVideo)).toBe('repair.refusal.repairTypeTerms');
  });

  test('a change keeps the terms a type already had, and a new one takes the list’s', async () => {
    const { h, sync, verdict, last } = await devices(7103);
    const { ticketId } = (await h.run(
      'openTicket',
      intake(h, { repairTypes: ['screen'] }),
      h.cashierId,
    )) as { ticketId: string };
    await h.run('setRepairTypes', { ticketId, repairTypes: ['screen', 'battery'] }, h.cashierId);
    const changed = await last(REPAIR_OP.ticketRepairTypesChanged);
    await sync(changed);

    expect(await verdict(changed)).toBeNull();
    const raised = tampered(changed, {
      repairTypes: [
        { item: 'screen', label: null, warrantyDays: 365, needsVideo: false },
        { item: 'battery', label: null, warrantyDays: 30, needsVideo: false },
      ],
    });
    expect(await verdict(raised)).toBe('repair.refusal.repairTypeTerms');
    const newOne = tampered(changed, {
      repairTypes: [
        { item: 'screen', label: null, warrantyDays: 30, needsVideo: false },
        { item: 'battery', label: null, warrantyDays: 90, needsVideo: false },
      ],
    });
    expect(await verdict(newOne)).toBe('repair.refusal.repairTypeTerms');
  });
});

test('an intake without a photo the store asks for is refused', async () => {
  const { h, sync, verdict, last } = await devices(7104);
  await h.run('openTicket', intake(h), h.cashierId);
  const opened = await last(REPAIR_OP.ticketOpened);
  await sync(opened);

  const photos = (opened.payload as { photos: { slot: string }[] }).photos;
  const short = tampered(opened, { photos: photos.filter((photo) => photo.slot !== 'back') });
  expect(await verdict(short)).toBe('repair.refusal.intakePhotoMissing');
});

test('an intake taken before the owner asked for another angle still counts', async () => {
  const { h, sync, verdict, last } = await devices(7105);
  await h.run('openTicket', intake(h), h.cashierId);
  const opened = await last(REPAIR_OP.ticketOpened);
  const angles = DEFAULT_INTAKE_OPTIONS.photoAngles.map(({ id, label }) => ({ id, label }));
  await h.run(
    'changeIntakeOptions',
    { list: 'photoAngles', items: [...angles, { id: null, label: 'Layar menyala' }] },
    h.ownerId,
  );
  await sync(opened);

  expect(await verdict(opened)).toBeNull();
});
