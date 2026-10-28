// Repair types ("Jenis servisan") through the real runtime: the owner's list and its terms, the
// types a servisan records at intake and keeps however the list changes later, who may change them
// until the phone goes home, and the warranty each one promises from pickup.
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

import { DomainError } from '@bolusi/core';
import { initI18n } from '@bolusi/i18n';

import idCatalog from '../repair/i18n/id.json' with { type: 'json' };
import enCatalog from '../repair/i18n/en.json' with { type: 'json' };
import { registerRepairCatalog } from '../src/repair/i18n.js';

import { REPAIR_OP } from '../src/repair/constants.js';
import {
  DEFAULT_INTAKE_OPTIONS,
  intakeListProblems,
  recordRepairTypes,
  repairTypeChoices,
  warrantyEnds,
  type RecordedRepairType,
} from '../src/repair/intake-options.js';
import { warrantyLine } from '../src/repair/labels.js';
import {
  intakeOptionsChangedPayload,
  intakeOptionsChangedPayloadV1,
  repairOperations,
  ticketOpenedPayload,
  ticketOpenedPayloadV2,
} from '../src/repair/operations.js';

import {
  intake,
  openRepairHarness,
  paidHandover,
  type RepairHarness,
} from './support/repair-harness.js';

const DAY = 86_400_000;

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

async function expectCode(p: Promise<unknown>, code: string): Promise<DomainError> {
  const err = await p.then(
    () => new Error(`expected ${code}, but the call resolved`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
  return err as DomainError;
}

async function openTicket(h: RepairHarness, repairTypes: string[]): Promise<string> {
  const { ticketId } = (await h.run('openTicket', intake(h, { repairTypes }), h.cashierId)) as {
    ticketId: string;
  };
  return ticketId;
}

async function types(h: RepairHarness, ticketId: string): Promise<RecordedRepairType[]> {
  return (await h.query('getTicket', { ticketId }, h.cashierId)).rows[0].repairTypes;
}

const screen: RecordedRepairType = {
  item: 'screen',
  label: null,
  warrantyDays: 30,
  needsVideo: false,
};

describe('the owner’s list', () => {
  test('ships with common repairs; unlocking needs the ownership video', () => {
    const unlock = DEFAULT_INTAKE_OPTIONS.repairTypes.find((type) => type.id === 'unlock');
    expect(unlock).toStrictEqual({ id: 'unlock', label: null, warrantyDays: 0, needsVideo: true });
    expect(DEFAULT_INTAKE_OPTIONS.repairTypes.filter((type) => type.needsVideo)).toHaveLength(1);
    expect(intakeListProblems('repairTypes', DEFAULT_INTAKE_OPTIONS.repairTypes)).toEqual([]);
  });

  test('every type carries whole warranty days up to a year and the video switch; other lists carry neither', () => {
    const type = (terms: object) => [{ id: 'x', label: 'Ganti LCD', ...terms }];
    expect(intakeListProblems('repairTypes', type({ warrantyDays: 0, needsVideo: false }))).toEqual(
      [],
    );
    expect(
      intakeListProblems('repairTypes', type({ warrantyDays: 365, needsVideo: true })),
    ).toEqual([]);
    for (const terms of [
      {},
      { warrantyDays: 30 },
      { needsVideo: false },
      { warrantyDays: -1, needsVideo: false },
      { warrantyDays: 366, needsVideo: false },
      { warrantyDays: 1.5, needsVideo: false },
    ]) {
      expect(intakeListProblems('repairTypes', type(terms))).toEqual(['badWarranty']);
    }
    expect(intakeListProblems('checks', [{ id: 'screen', label: null, warrantyDays: 30 }])).toEqual(
      ['badWarranty'],
    );
  });

  test('the owner saves new terms and a new type; a cashier may not', async () => {
    const h = await harness(6101);
    const items = [
      { id: 'screen', label: null, warrantyDays: 90, needsVideo: false },
      { id: null, label: 'Reset iCloud', warrantyDays: 0, needsVideo: true },
    ];
    await expectCode(
      h.run('changeIntakeOptions', { list: 'repairTypes', items }, h.cashierId),
      'PERMISSION_DENIED',
    );
    await h.run('changeIntakeOptions', { list: 'repairTypes', items }, h.ownerId);
    const saved = (await h.query('intakeOptionSettings', {}, h.cashierId)).rows[0].lists
      .repairTypes;
    expect(saved[0]).toStrictEqual(items[0]);
    expect(saved[1]).toMatchObject({ label: 'Reset iCloud', warrantyDays: 0, needsVideo: true });
    await expectCode(
      h.run(
        'changeIntakeOptions',
        { list: 'repairTypes', items: [{ id: 'screen', label: null }] },
        h.ownerId,
      ),
      'VALIDATION_FAILED',
    );
  });
});

describe('a servisan’s repair types', () => {
  test('intake records the picked types with their terms, in the order picked', async () => {
    const h = await harness(6102);
    const ticketId = await openTicket(h, ['unlock', 'screen']);
    expect(await types(h, ticketId)).toStrictEqual([
      { item: 'unlock', label: null, warrantyDays: 0, needsVideo: true },
      screen,
    ]);
    expect(await types(h, await openTicket(h, []))).toStrictEqual([]);
  });

  test('intake refuses a type the store does not offer, and a type picked twice', async () => {
    const h = await harness(6103);
    await h.run('hideIntakeOptions', { list: 'repairTypes', hidden: ['unlock'] }, h.storeOwnerId);
    await expectCode(openTicket(h, ['unlock']), 'VALIDATION_FAILED');
    await expectCode(openTicket(h, ['nope']), 'VALIDATION_FAILED');
    await expectCode(openTicket(h, ['screen', 'screen']), 'VALIDATION_FAILED');
  });

  test('a later change to the list never changes the warranty a servisan was given', async () => {
    const h = await harness(6104);
    const ticketId = await openTicket(h, ['screen']);
    await h.run(
      'changeIntakeOptions',
      {
        list: 'repairTypes',
        items: [
          { id: 'screen', label: 'LCD', warrantyDays: 7, needsVideo: false },
          { id: 'battery', label: null, warrantyDays: 60, needsVideo: false },
        ],
      },
      h.ownerId,
    );
    await h.run('setRepairTypes', { ticketId, repairTypes: ['screen', 'battery'] }, h.technicianId);
    expect(await types(h, ticketId)).toStrictEqual([
      screen,
      { item: 'battery', label: null, warrantyDays: 60, needsVideo: false },
    ]);
  });

  test('the counter or a technician changes them; nobody else, and not to the same types', async () => {
    const h = await harness(6105);
    const ticketId = await openTicket(h, ['screen']);
    await h.run('setRepairTypes', { ticketId, repairTypes: ['screen', 'battery'] }, h.cashierId);
    await h.run('setRepairTypes', { ticketId, repairTypes: ['battery'] }, h.technicianId);
    expect((await types(h, ticketId)).map((type) => type.item)).toEqual(['battery']);
    await expectCode(
      h.run('setRepairTypes', { ticketId, repairTypes: ['battery'] }, h.technicianId),
      'VALIDATION_FAILED',
    );
    await expectCode(
      h.run('setRepairTypes', { ticketId, repairTypes: ['screen'] }, h.zeroUserId),
      'PERMISSION_DENIED',
    );
    const events = (await h.query('getTicket', { ticketId }, h.cashierId)).rows[0].events;
    expect(
      events.filter((e: { kind: string }) => e.kind === REPAIR_OP.ticketRepairTypesChanged),
    ).toHaveLength(2);
  });

  test('a type the store hides or dropped since stays offered on a servisan that has it', async () => {
    const h = await harness(6106);
    const ticketId = await openTicket(h, ['screen', 'unlock']);
    await h.run('hideIntakeOptions', { list: 'repairTypes', hidden: ['unlock'] }, h.storeOwnerId);
    await h.run('setRepairTypes', { ticketId, repairTypes: ['unlock'] }, h.cashierId);
    expect((await types(h, ticketId)).map((type) => type.item)).toEqual(['unlock']);
    const offered = DEFAULT_INTAKE_OPTIONS.repairTypes.filter((type) => type.id !== 'unlock');
    const choices = repairTypeChoices(offered, await types(h, ticketId));
    expect(choices.at(-1)).toStrictEqual({
      id: 'unlock',
      label: null,
      warrantyDays: 0,
      needsVideo: true,
    });
  });

  test('cannot change once the phone went home or the servisan was cancelled', async () => {
    const h = await harness(6107);
    const returned = await openTicket(h, ['screen']);
    await h.run('startWork', { ticketId: returned, beforePhotos: [h.photo(1)] }, h.technicianId);
    await h.run('markRepaired', { ticketId: returned, afterPhotos: [h.photo(2)] }, h.technicianId);
    await h.run(
      'returnDevice',
      (await paidHandover(h, returned, {}, [3, 4])) as never,
      h.cashierId,
    );
    const cancelled = await openTicket(h, ['screen']);
    await h.run('cancelTicket', { ticketId: cancelled, reason: 'Batal', fee: 0 }, h.storeOwnerId);
    for (const ticketId of [returned, cancelled]) {
      await expectCode(
        h.run('setRepairTypes', { ticketId, repairTypes: ['battery'] }, h.cashierId),
        'INVALID_TRANSITION',
      );
    }
  });
});

describe('older signed changes', () => {
  test('an intake signed before repair types opens a servisan with none', () => {
    const op = repairOperations[REPAIR_OP.ticketOpened]!;
    expect(op.schemaVersion).toBe(3);
    expect(op.payload).toBe(ticketOpenedPayload);
    expect(op.payloadByVersion?.[2]).toBe(ticketOpenedPayloadV2);
    expect(ticketOpenedPayloadV2.shape).not.toHaveProperty('repairTypes');
  });

  test('a list change signed before repair types cannot name them; v2 carries their terms', () => {
    const items = [{ id: 'screen', label: null, warrantyDays: 30, needsVideo: false }];
    expect(
      intakeOptionsChangedPayloadV1.safeParse({ list: 'repairTypes', items: [] }).success,
    ).toBe(false);
    expect(intakeOptionsChangedPayload.safeParse({ list: 'repairTypes', items }).success).toBe(
      true,
    );
    expect(
      intakeOptionsChangedPayload.safeParse({
        list: 'repairTypes',
        items: [{ ...items[0], warrantyDays: 400 }],
      }).success,
    ).toBe(false);
  });
});

describe('the warranty', () => {
  const pickedUp = Date.UTC(2026, 9, 28, 3);

  test('counts the type’s days from pickup; none for a type without one or a phone still in the store', () => {
    expect(warrantyEnds(screen, pickedUp)).toBe(pickedUp + 30 * DAY);
    expect(warrantyEnds(screen, null)).toBeNull();
    expect(warrantyEnds({ warrantyDays: 0 }, pickedUp)).toBeNull();
  });

  test('reads as the counter tells the customer', () => {
    expect(warrantyLine(screen, null)).toBe('Ganti layar · garansi 30 hari');
    expect(warrantyLine(screen, pickedUp)).toMatch(
      /^Ganti layar · garansi s\/d \d{2}\/\d{2}\/2026$/,
    );
    expect(warrantyLine({ ...screen, item: 'x', label: 'Kena air', warrantyDays: 0 }, null)).toBe(
      'Kena air · tanpa garansi',
    );
  });

  test('records the terms the type had, or refuses one that is not offered', () => {
    const offered = [{ id: 'screen', label: null, warrantyDays: 30, needsVideo: false }];
    expect(recordRepairTypes(['screen'], offered)).toStrictEqual({ types: [screen] });
    expect(recordRepairTypes(['screen', 'gone'], offered)).toStrictEqual({ unknown: 'gone' });
    const kept = { ...screen, item: 'gone', warrantyDays: 14 };
    expect(recordRepairTypes(['gone'], offered, [kept])).toStrictEqual({ types: [kept] });
  });
});
