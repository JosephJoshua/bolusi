// The handover checklist instead of a QC step: on a repaired phone the store's handover checks,
// then every accessory left at intake. The rule, on the device and the server, never lets an
// accessory drop off the list and wants a note for anything not ticked; the servisan's history
// keeps what was and was not checked.
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

import { DomainError } from '@bolusi/core';
import { initI18n } from '@bolusi/i18n';

import idCatalog from '../repair/i18n/id.json' with { type: 'json' };
import enCatalog from '../repair/i18n/en.json' with { type: 'json' };
import { REPAIR_OP } from '../src/repair/constants.js';
import { registerRepairCatalog } from '../src/repair/i18n.js';
import {
  DEFAULT_INTAKE_OPTIONS,
  handoverChecklist,
  handoverProblem,
  intakeListProblems,
} from '../src/repair/intake-options.js';
import { eventNote } from '../src/repair/labels.js';

import {
  accessoriesBack,
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

async function repaired(h: RepairHarness): Promise<string> {
  const { ticketId } = (await h.run('openTicket', intake(h), h.cashierId)) as { ticketId: string };
  await h.run('startWork', { ticketId, beforePhotos: [h.photo(1)] }, h.technicianId);
  await h.run('markRepaired', { ticketId, afterPhotos: [h.photo(2)] }, h.technicianId);
  return ticketId;
}

async function ticket(h: RepairHarness, ticketId: string) {
  return (await h.query('getTicket', { ticketId }, h.cashierId)).rows[0];
}

async function refusal(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => new Error('expected a refusal, but the call resolved'),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe('VALIDATION_FAILED');
  return JSON.stringify(err);
}

const tried = { kind: 'check', item: 'customerTried', label: null } as const;
const works = { kind: 'check', item: 'repairWorks', label: null } as const;

describe('the checklist', () => {
  const accessories = [
    { item: 'charger', label: null },
    { item: 'acc-1', label: 'Tali HP' },
  ];

  test('a repaired phone gets the store’s checks, then each accessory; a cancelled one only its accessories', () => {
    const checks = DEFAULT_INTAKE_OPTIONS.handoverChecks;
    expect(handoverChecklist('repaired', accessories, checks)).toEqual([
      { ...tried, done: false },
      { ...works, done: false },
      { kind: 'accessory', item: 'charger', label: null, done: false },
      { kind: 'accessory', item: 'acc-1', label: 'Tali HP', done: false },
    ]);
    expect(handoverChecklist('cancelled', accessories, checks).map((line) => line.kind)).toEqual([
      'accessory',
      'accessory',
    ]);
  });

  test('every accessory must be on it, and anything unticked needs a note', () => {
    const all = handoverChecklist('repaired', accessories, DEFAULT_INTAKE_OPTIONS.handoverChecks);
    const ticked = all.map((line) => ({ ...line, done: true }));
    expect(handoverProblem(ticked, accessories, '')).toBeNull();
    expect(handoverProblem(ticked.slice(0, 3), accessories, 'semua ada')).toBe(
      'handoverAccessories',
    );
    const chargerMissing = ticked.map((line) =>
      line.item === 'charger' ? { ...line, done: false } : line,
    );
    expect(handoverProblem(chargerMissing, accessories, ' ')).toBe('handoverNoteNeeded');
    expect(handoverProblem(chargerMissing, accessories, 'Charger tertinggal di rumah')).toBeNull();
  });

  test('the owner can rename, add to or empty the list', () => {
    expect(intakeListProblems('handoverChecks', [])).toEqual([]);
    expect(
      intakeListProblems('handoverChecks', [
        { id: 'customerTried', label: null },
        { id: 'x1', label: 'Data pelanggan aman' },
      ]),
    ).toEqual([]);
    expect(intakeListProblems('handoverChecks', [{ id: 'made-up', label: null }])).toEqual([
      'notBuiltIn',
    ]);
  });
});

describe('handing the phone back', () => {
  test('refused while an accessory left at intake is missing from the list', async () => {
    const h = await harness(7301);
    const ticketId = await repaired(h);
    const input = await paidHandover(h, ticketId, { checklist: accessoriesBack().slice(0, 1) });
    expect(await refusal(h.run('returnDevice', input as never, h.cashierId))).toContain(
      'repair.refusal.handoverAccessories',
    );
  });

  test('something not ticked needs a note; with one it goes, and the history says what was checked', async () => {
    const h = await harness(7302);
    const ticketId = await repaired(h);
    const checklist = [
      { ...tried, done: true },
      { ...works, done: true },
      { kind: 'accessory', item: 'charger', label: null, done: true },
      { kind: 'accessory', item: 'case', label: null, done: false },
    ];
    const input = await paidHandover(h, ticketId, { checklist });
    expect(await refusal(h.run('returnDevice', input as never, h.cashierId))).toContain(
      'repair.refusal.handoverNoteNeeded',
    );

    await h.run(
      'returnDevice',
      { ...input, note: 'Casing diambil minggu depan' } as never,
      h.cashierId,
    );
    const row = await ticket(h, ticketId);
    expect(row.location).toBe('returned');
    const event = row.events.find((e: { kind: string }) => e.kind === REPAIR_OP.deviceReturned) as {
      detail: Record<string, unknown>;
    };
    expect(event.detail).toEqual({ note: 'Casing diambil minggu depan', checklist });
    expect(eventNote(event.detail)).toBe(
      [
        'Dicek: Sudah dicoba pelanggan, Bagian yang diperbaiki berfungsi, Charger',
        'Belum: Casing',
        'Casing diambil minggu depan',
      ].join('\n'),
    );
  });

  test('a handover an older app signed, without a checklist, still folds', async () => {
    const a = await harness(7303);
    const ticketId = await repaired(a);
    await a.run('returnDevice', (await paidHandover(a, ticketId)) as never, a.cashierId);
    const ops = await a.ownOps();
    const v3 = ops.find((op) => op.type === REPAIR_OP.deviceReturned)!;
    const v2Payload: Record<string, unknown> = { ...(v3.payload as object) };
    delete v2Payload['checklist'];
    const v2 = { ...v3, schemaVersion: 2, payload: v2Payload };

    const b = await openRepairHarness(7304, {
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
    for (const op of ops) await b.deliverPulled(op === v3 ? (v2 as never) : op, arrival++);
    const row = await ticket(b, ticketId);
    expect(row.location).toBe('returned');
    const event = row.events.find((e: { kind: string }) => e.kind === REPAIR_OP.deviceReturned) as {
      detail: Record<string, unknown>;
    };
    expect(event.detail).toEqual({ note: '' });
  });
});
