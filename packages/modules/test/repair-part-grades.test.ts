// Part grades (Original, OEM, KW): the owner's list and each repair type's warranty per grade, the
// grade the customer agrees to at intake and when the repair types change, what the server accepts
// of a pushed one, and how the servisan and its nota name it.
import { initI18n } from '@bolusi/i18n';
import { PAPER_PRESETS, layoutGrid, refusalKeyOf, type GridRow } from '@bolusi/core';
import { DomainError } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';

import idCatalog from '../repair/i18n/id.json' with { type: 'json' };
import enCatalog from '../repair/i18n/en.json' with { type: 'json' };
import { REPAIR_OP } from '../src/repair/constants.js';
import {
  emptyIntakeDraft,
  gradeQuestions,
  stepProblems,
  toOpenTicketInput,
} from '../src/repair/flows.js';
import { registerRepairCatalog } from '../src/repair/i18n.js';
import {
  DEFAULT_INTAKE_OPTIONS,
  intakeListProblems,
  recordRepairTypes,
  type IntakeOption,
  type RecordedRepairType,
} from '../src/repair/intake-options.js';
import { repairTypeLabel, warrantyLine } from '../src/repair/labels.js';
import {
  changedItems,
  editorFor,
  editorProblems,
  setGradeWarranty,
  toggleGrade,
} from '../src/repair/options-editor.js';
import { handoverSlip } from '../src/repair/print.js';

import { intake, openRepairHarness, type RepairHarness } from './support/repair-harness.js';
import { sampleTicket } from './support/repair-rows.js';

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

async function refused(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => new Error(`expected ${code}, but the call resolved`),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
}

/** The screen in three grades at three warranties, and software, which fits no part. */
const GRADED: IntakeOption[] = [
  {
    id: 'screen',
    label: null,
    warrantyDays: 30,
    needsVideo: false,
    grades: [
      { id: 'original', warrantyDays: 30 },
      { id: 'oem', warrantyDays: 14 },
      { id: 'kw', warrantyDays: 7 },
    ],
  },
  { id: 'software', label: null, warrantyDays: 7, needsVideo: false },
];

async function setScreenGrades(h: RepairHarness): Promise<void> {
  await h.run('changeIntakeOptions', { list: 'repairTypes', items: GRADED }, h.ownerId);
}

async function openWith(
  h: RepairHarness,
  repairTypes: string[],
  grades: Record<string, string>,
): Promise<string> {
  const { ticketId } = (await h.run(
    'openTicket',
    intake(h, { repairTypes, grades }),
    h.cashierId,
  )) as { ticketId: string };
  return ticketId;
}

async function types(h: RepairHarness, ticketId: string): Promise<RecordedRepairType[]> {
  return (await h.query('getTicket', { ticketId }, h.cashierId)).rows[0].repairTypes;
}

describe('the owner’s list', () => {
  test('ships Original, OEM and KW, and every part repair offers each at its own warranty', () => {
    expect(DEFAULT_INTAKE_OPTIONS.grades.map((grade) => grade.id)).toEqual([
      'original',
      'oem',
      'kw',
    ]);
    const screen = DEFAULT_INTAKE_OPTIONS.repairTypes.find((type) => type.id === 'screen')!;
    expect(screen.grades?.map((grade) => grade.warrantyDays)).toEqual([30, 30, 30]);
    const software = DEFAULT_INTAKE_OPTIONS.repairTypes.find((type) => type.id === 'software')!;
    expect(software.grades).toBeUndefined();
    expect(intakeListProblems('repairTypes', DEFAULT_INTAKE_OPTIONS.repairTypes)).toEqual([]);
  });

  test('a grade’s warranty is whole days up to a year, each grade once, and only on repair types', () => {
    const type = (grades: { id: string; warrantyDays: number }[]) => [
      { id: 'x', label: 'Ganti LCD', warrantyDays: 30, needsVideo: false, grades },
    ];
    expect(intakeListProblems('repairTypes', type([{ id: 'kw', warrantyDays: 0 }]))).toEqual([]);
    for (const grades of [
      [{ id: 'kw', warrantyDays: 366 }],
      [{ id: 'kw', warrantyDays: 1.5 }],
      [
        { id: 'kw', warrantyDays: 7 },
        { id: 'kw', warrantyDays: 14 },
      ],
    ]) {
      expect(intakeListProblems('repairTypes', type(grades))).toEqual(['badWarranty']);
    }
    expect(
      intakeListProblems('grades', [{ id: 'kw', label: null, grades: [] } as IntakeOption]),
    ).toEqual(['badWarranty']);
  });

  test('the owner renames and adds grades; a store hides one it does not sell', async () => {
    const h = await harness(8101);
    await h.run(
      'changeIntakeOptions',
      {
        list: 'grades',
        items: [
          { id: 'original', label: 'Ori' },
          { id: 'kw', label: null },
          { id: null, label: 'Copotan' },
        ],
      },
      h.ownerId,
    );
    await h.run('hideIntakeOptions', { list: 'grades', hidden: ['kw'] }, h.storeOwnerId);
    const settings = (await h.query('intakeOptionSettings', {}, h.cashierId)).rows[0];
    expect(settings.lists.grades.map((grade: IntakeOption) => grade.label)).toEqual([
      'Ori',
      null,
      'Copotan',
    ]);
    expect(settings.hidden.grades).toEqual(['kw']);
    await refused(
      h.run('changeIntakeOptions', { list: 'grades', items: [] }, h.cashierId),
      'PERMISSION_DENIED',
    );
  });
});

describe('at intake', () => {
  test('records the grade the customer agreed to, with that grade’s warranty', async () => {
    const h = await harness(8102);
    await setScreenGrades(h);
    const ticketId = await openWith(h, ['screen', 'software'], { screen: 'kw' });
    expect(await types(h, ticketId)).toStrictEqual([
      {
        item: 'screen',
        label: null,
        warrantyDays: 7,
        needsVideo: false,
        grade: { item: 'kw', label: null },
      },
      { item: 'software', label: null, warrantyDays: 7, needsVideo: false, grade: null },
    ]);
  });

  test('a part repair needs one of its grades; a repair with no part takes none', async () => {
    const h = await harness(8103);
    await setScreenGrades(h);
    await refused(openWith(h, ['screen'], {}), 'VALIDATION_FAILED');
    await refused(openWith(h, ['screen'], { screen: 'copotan' }), 'VALIDATION_FAILED');
    // A grade sent along for a repair that fits no part is not recorded.
    const ticketId = await openWith(h, ['software'], { software: 'kw' });
    expect((await types(h, ticketId))[0]!.grade).toBeNull();
  });

  test('a grade the store hides is not offered, and one taken off every type leaves none to ask', async () => {
    const h = await harness(8104);
    await setScreenGrades(h);
    await h.run('hideIntakeOptions', { list: 'grades', hidden: ['kw'] }, h.storeOwnerId);
    await refused(openWith(h, ['screen'], { screen: 'kw' }), 'VALIDATION_FAILED');
    await h.run(
      'hideIntakeOptions',
      { list: 'grades', hidden: ['original', 'oem', 'kw'] },
      h.storeOwnerId,
    );
    const ticketId = await openWith(h, ['screen'], {});
    expect(await types(h, ticketId)).toMatchObject([{ item: 'screen', grade: null }]);
  });

  test('the counter must pick a grade before going on, and the pick reaches the command', () => {
    const options = { ...DEFAULT_INTAKE_OPTIONS, repairTypes: GRADED };
    const draft = {
      ...emptyIntakeDraft(),
      complaint: 'Layar pecah',
      repairTypes: ['screen', 'software'],
    };
    expect(stepProblems(draft, 'condition', options)).toEqual(['grade']);
    expect(gradeQuestions(draft.repairTypes, GRADED, options.grades).map((q) => q.type.id)).toEqual(
      ['screen'],
    );
    const picked = { ...draft, grades: { screen: 'oem', software: 'kw' } };
    expect(stepProblems(picked, 'condition', options)).toEqual([]);
    // A claim repairs what its servisan did, so it picks nothing.
    const claim = {
      ...draft,
      claimOf: { ticketId: 't', ticketNumber: 'A-1', warrantyUntil: null, imei: '' },
    };
    expect(stepProblems(claim, 'condition', options)).toEqual([]);
    expect(toOpenTicketInput(picked, options, 0).grades).toEqual({ screen: 'oem' });
  });
});

describe('after intake', () => {
  test('another grade takes that grade’s warranty; the same grade keeps what was promised', async () => {
    const h = await harness(8105);
    await setScreenGrades(h);
    const ticketId = await openWith(h, ['screen'], { screen: 'original' });
    // The owner shortens the original screen's warranty: the servisan keeps its 30 days.
    await h.run(
      'changeIntakeOptions',
      {
        list: 'repairTypes',
        items: [
          {
            ...GRADED[0]!,
            grades: [
              { id: 'original', warrantyDays: 21 },
              { id: 'kw', warrantyDays: 7 },
            ],
          },
          GRADED[1]!,
        ],
      },
      h.ownerId,
    );
    await h.run(
      'setRepairTypes',
      { ticketId, repairTypes: ['screen', 'software'], grades: { screen: 'original' } },
      h.technicianId,
    );
    expect((await types(h, ticketId))[0]).toMatchObject({ warrantyDays: 30 });
    // The customer agreed to a KW screen instead: the KW warranty, now.
    await h.run(
      'setRepairTypes',
      { ticketId, repairTypes: ['screen'], grades: { screen: 'kw' } },
      h.cashierId,
    );
    expect(await types(h, ticketId)).toMatchObject([
      { item: 'screen', warrantyDays: 7, grade: { item: 'kw' } },
    ]);
    await refused(
      h.run('setRepairTypes', { ticketId, repairTypes: ['screen'], grades: {} }, h.cashierId),
      'VALIDATION_FAILED',
    );
    await refused(
      h.run(
        'setRepairTypes',
        { ticketId, repairTypes: ['screen'], grades: { screen: 'kw' } },
        h.cashierId,
      ),
      'VALIDATION_FAILED',
    );
  });

  test('a kept type keeps its grade, a new one takes the list’s, and none asks twice', () => {
    const kept: RecordedRepairType = {
      item: 'screen',
      label: null,
      warrantyDays: 30,
      needsVideo: false,
      grade: { item: 'original', label: null },
    };
    const grades = DEFAULT_INTAKE_OPTIONS.grades;
    expect(recordRepairTypes(['screen'], GRADED, [kept], { screen: 'original' }, grades)).toEqual({
      types: [kept],
    });
    expect(recordRepairTypes(['screen'], [], [kept], {}, grades)).toEqual({ types: [kept] });
    expect(recordRepairTypes(['screen'], GRADED, [kept], {}, grades)).toEqual({
      gradeNeeded: 'screen',
    });
  });
});

describe('what the server accepts', () => {
  async function devices(seed: number) {
    const h = await openRepairHarness(seed);
    const server = await openRepairHarness(seed + 50, {
      tenantId: h.tenantId,
      storeId: h.storeId,
      users: [h.cashierId, h.technicianId, h.ownerId, h.storeOwnerId],
    });
    open.push(h, server);
    const sync = async (skip: SignedOperation): Promise<void> => {
      let arrival = 0;
      for (const op of await h.ownOps()) {
        if (op.id !== skip.id) await server.deliverPulled(op, (arrival += 1));
      }
    };
    const verdict = (op: SignedOperation): Promise<string | null> =>
      server.checkRule(op).then(
        () => null,
        (error: unknown) => refusalKeyOf(error) ?? String(error),
      );
    return { h, sync, verdict };
  }

  const tampered = (op: SignedOperation, repairTypes: object[]): SignedOperation =>
    ({ ...op, payload: { ...(op.payload as object), repairTypes } }) as never;

  test('a grade’s warranty and name come from the owner’s list, never the device', async () => {
    const { h, sync, verdict } = await devices(8106);
    await setScreenGrades(h);
    await openWith(h, ['screen'], { screen: 'kw' });
    const opened = (await h.ownOps()).filter((op) => op.type === REPAIR_OP.ticketOpened).at(-1)!;
    await sync(opened);
    expect(await verdict(opened)).toBeNull();

    const screen = { item: 'screen', label: null, needsVideo: false };
    // KW fitted, but more days promised than any version of the list gave it.
    expect(
      await verdict(
        tampered(opened, [{ ...screen, warrantyDays: 31, grade: { item: 'kw', label: null } }]),
      ),
    ).toBe('repair.refusal.repairTypeTerms');
    // KW fitted, printed as "Original".
    expect(
      await verdict(
        tampered(opened, [
          { ...screen, warrantyDays: 7, grade: { item: 'kw', label: 'Original' } },
        ]),
      ),
    ).toBe('repair.refusal.repairTypeTerms');
    // A grade the screen was never offered in.
    expect(
      await verdict(
        tampered(opened, [
          { ...screen, warrantyDays: 7, grade: { item: 'copotan', label: 'Copotan' } },
        ]),
      ),
    ).toBe('repair.refusal.repairTypeTerms');
  });
});

describe('how a servisan names it', () => {
  const kw: RecordedRepairType = {
    item: 'screen',
    label: null,
    warrantyDays: 7,
    needsVideo: false,
    grade: { item: 'kw', label: null },
  };

  test('beside the repair type, in the name the store gave it', () => {
    expect(repairTypeLabel(kw)).toBe('Ganti layar (KW)');
    expect(repairTypeLabel({ ...kw, grade: { item: 'g1', label: 'Copotan' } })).toBe(
      'Ganti layar (Copotan)',
    );
    expect(repairTypeLabel({ ...kw, grade: null })).toBe('Ganti layar');
    expect(warrantyLine(kw, null)).toBe('Ganti layar (KW) · garansi 7 hari');
  });

  test('on the nota, with the grade’s warranty', () => {
    const rowText = (row: GridRow): string =>
      row.kind === 'text' ? row.text : row.lead.map((span) => span.text).join('');
    const doc = handoverSlip(
      sampleTicket({
        outcome: 'repaired',
        location: 'returned',
        returnedAt: Date.UTC(2026, 9, 1, 3),
        repairTypes: [kw],
      }),
      {
        header: { name: 'Bolusi Cell Sorong', lines: [], logo: null },
        terms: null,
        link: null,
        handedOverByName: null,
        signature: null,
      },
    );
    const text = layoutGrid(doc, { ...PAPER_PRESETS.continuous_full, carbonless: false })
      .pages.flat()
      .map(rowText)
      .join('\n');
    expect(text).toMatch(/Jenis servisan\s+: Ganti layar \(KW\)/);
    expect(text).toMatch(/Ganti layar \(KW\)\s+: s\/d 08\/10\/2026/);
  });
});

describe('the owner’s editor', () => {
  test('a repair type offered in grades saves each grade’s days, and a bad one is pointed at', () => {
    const settings = {
      lists: { ...DEFAULT_INTAKE_OPTIONS, repairTypes: [GRADED[1]!] },
      hidden: { ...DEFAULT_INTAKE_OPTIONS, repairTypes: [] },
    } as never;
    let state = editorFor('repairTypes', settings, () => 'Software');
    state = toggleGrade(state, 'software', 'original');
    state = toggleGrade(state, 'software', 'kw');
    // A grade newly offered starts at the type's own warranty.
    expect(state.rows[0]!.grades).toEqual([
      { id: 'original', warranty: '7' },
      { id: 'kw', warranty: '7' },
    ]);
    state = setGradeWarranty(state, 'software', 'original', '30');
    expect(changedItems(state, [GRADED[1]!], () => 'Software')).toEqual([
      {
        id: 'software',
        label: null,
        warrantyDays: 30,
        needsVideo: false,
        grades: [
          { id: 'original', warrantyDays: 30 },
          { id: 'kw', warrantyDays: 7 },
        ],
      },
    ]);
    state = setGradeWarranty(state, 'software', 'kw', '');
    const problems = editorProblems(
      state,
      () => 'Software',
      () => 'Software',
    );
    expect(problems.rows.get('software')).toBe('badWarranty');
    state = toggleGrade(state, 'software', 'kw');
    state = toggleGrade(state, 'software', 'original');
    expect(changedItems(state, [GRADED[1]!], () => 'Software')).toBeNull();
  });
});
