// The ownership video: the customer saying on camera that the phone is theirs, asked for by the
// repair types that need it (unlocking, by default). The counter takes it at intake, and only
// there: the handover's proof is its photo. The same rules refuse on the device and the server.
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

import { DomainError } from '@bolusi/core';
import { initI18n } from '@bolusi/i18n';

import idCatalog from '../repair/i18n/id.json' with { type: 'json' };
import enCatalog from '../repair/i18n/en.json' with { type: 'json' };
import { REPAIR_OP } from '../src/repair/constants.js';
import {
  emptyIntakeDraft,
  intakeNeedsVideo,
  ownershipVideoOf,
  stepProblems,
  toOpenTicketInput,
  type IntakeDraft,
} from '../src/repair/flows.js';
import { registerRepairCatalog } from '../src/repair/i18n.js';
import { DEFAULT_INTAKE_OPTIONS } from '../src/repair/intake-options.js';

import {
  intake,
  openRepairHarness,
  paidHandover,
  type RepairHarness,
} from './support/repair-harness.js';

beforeAll(() => {
  initI18n({ locale: 'id' });
  registerRepairCatalog({ id: idCatalog, en: enCatalog });
});

const open: RepairHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function harness(seed: number): Promise<RepairHarness> {
  const h = await openRepairHarness(seed);
  open.push(h);
  return h;
}

async function refusal(p: Promise<unknown>): Promise<DomainError> {
  const err = await p.then(
    () => new Error('expected a refusal, but the call resolved'),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  return err as DomainError;
}

async function ticket(h: RepairHarness, ticketId: string) {
  return (await h.query('getTicket', { ticketId }, h.cashierId)).rows[0];
}

async function opened(h: RepairHarness, overrides: Record<string, unknown>): Promise<string> {
  const { ticketId } = (await h.run('openTicket', intake(h, overrides), h.cashierId)) as {
    ticketId: string;
  };
  return ticketId;
}

async function repair(h: RepairHarness, ticketId: string): Promise<void> {
  await h.run('startWork', { ticketId, beforePhotos: [h.photo(1)] }, h.technicianId);
  await h.run('markRepaired', { ticketId, afterPhotos: [h.photo(2)] }, h.technicianId);
}

describe('at intake', () => {
  test('a type that needs the video is refused without one, and opens with it', async () => {
    const h = await harness(7401);
    const err = await refusal(
      h.run('openTicket', intake(h, { repairTypes: ['unlock'] }), h.cashierId),
    );
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.message).toBe('repair.refusal.ownershipVideoNeeded');

    const video = h.video(1);
    const ticketId = await opened(h, { repairTypes: ['unlock'], ownershipVideo: video });
    const row = await ticket(h, ticketId);
    expect(ownershipVideoOf(row)).toMatchObject({ mediaId: video.mediaId, mediaMime: 'video/mp4' });
    // The clip rides with the photos but is not one of the intake shots.
    expect(row.photos.filter((photo: { slot: string }) => photo.slot === 'front')).toHaveLength(1);
  });

  test('a type that does not need one opens without it', async () => {
    const h = await harness(7402);
    const row = await ticket(h, await opened(h, { repairTypes: ['screen'] }));
    expect(ownershipVideoOf(row)).toBeNull();
  });

  test('an intake an older app signed, with no video, still folds', async () => {
    const a = await harness(7403);
    const ticketId = await opened(a, { repairTypes: ['unlock'], ownershipVideo: a.video(1) });
    const ops = await a.ownOps();
    const v4 = ops.find((op) => op.type === REPAIR_OP.ticketOpened)!;
    const v3Payload: Record<string, unknown> = { ...(v4.payload as object) };
    delete v3Payload['ownershipVideo'];
    const v3 = { ...v4, schemaVersion: 3, payload: v3Payload };

    const b = await openRepairHarness(7404, {
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
    for (const op of ops) await b.deliverPulled(op === v4 ? (v3 as never) : op, arrival++);
    const row = await ticket(b, ticketId);
    expect(row.repairTypes.map((type: { item: string }) => type.item)).toEqual(['unlock']);
    expect(ownershipVideoOf(row)).toBeNull();
  });
});

describe('after intake', () => {
  test('a type that needs the video, added later, does not hold the phone at pickup', async () => {
    const h = await harness(7405);
    const ticketId = await opened(h, { repairTypes: ['screen'] });
    await h.run('setRepairTypes', { ticketId, repairTypes: ['screen', 'unlock'] }, h.cashierId);
    await repair(h, ticketId);
    await h.run('returnDevice', (await paidHandover(h, ticketId)) as never, h.cashierId);
    const row = await ticket(h, ticketId);
    expect(row.location).toBe('returned');
    expect(ownershipVideoOf(row)).toBeNull();
  });
});

describe('the intake draft', () => {
  const options = DEFAULT_INTAKE_OPTIONS;
  const draft = (patch: Partial<IntakeDraft>): IntakeDraft => ({
    ...emptyIntakeDraft(),
    ...patch,
  });

  test('asks for the video on the photos step only while a picked type needs it', () => {
    expect(intakeNeedsVideo(draft({ repairTypes: ['screen'] }), options)).toBe(false);
    expect(intakeNeedsVideo(draft({ repairTypes: ['screen', 'unlock'] }), options)).toBe(true);
    expect(stepProblems(draft({ repairTypes: ['unlock'] }), 'photos', options, [])).toContain(
      'ownershipVideo',
    );
    expect(stepProblems(draft({ repairTypes: ['screen'] }), 'photos', options, [])).not.toContain(
      'ownershipVideo',
    );
  });

  test('a warranty claim asks for none: the phone was proven theirs the first time', () => {
    const claim = draft({
      repairTypes: ['unlock'],
      claimOf: { ticketId: 't-1', ticketNumber: 'SRV-1', warrantyUntil: null },
    } as Partial<IntakeDraft>);
    expect(intakeNeedsVideo(claim, options)).toBe(false);
  });
});

describe('the intake input', () => {
  test('a clip taken for a type the counter then unpicked is dropped', async () => {
    const h = await harness(7408);
    const video = h.video(1);
    const base = { ...emptyIntakeDraft(), ownershipVideo: video };
    const kept = toOpenTicketInput({ ...base, repairTypes: ['unlock'] }, DEFAULT_INTAKE_OPTIONS, 0);
    const dropped = toOpenTicketInput(
      { ...base, repairTypes: ['screen'] },
      DEFAULT_INTAKE_OPTIONS,
      0,
    );
    expect(kept.ownershipVideo).toEqual(video);
    expect(dropped.ownershipVideo).toBeNull();
  });
});
