// The phone's slip paper in Settings: picked once and saved at once, with a test page through the
// phone's print dialog to check it before a customer's slip goes on it.
import type { PaperSettings } from '@bolusi/core';
import { color } from '@bolusi/ui';
import {
  PaperScreen,
  RepairRuntimeProvider,
  type RepairPrinting,
} from '@bolusi/modules/repair/screens';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  ensureRepairCatalog,
  fire,
  openRepairScreenHarness,
  press,
  render,
  repairRuntimeFor,
  settle,
  type as typeInto,
  type RepairHarness,
} from '../../../test/repair-support.js';

let h: RepairHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

function fakePrinting(): RepairPrinting & { readonly saved: PaperSettings[] } {
  const saved: PaperSettings[] = [];
  return {
    saved,
    storeName: () => Promise.resolve('Toko Sorong Kota'),
    userName: () => Promise.resolve('Andi'),
    readPaper: () => Promise.resolve(saved.at(-1) ?? null),
    writePaper: (paper) => {
      saved.push(paper);
      return Promise.resolve();
    },
    output: vi.fn<RepairPrinting['output']>(() => Promise.resolve('unconfirmed')),
    imageDataUri: () => Promise.resolve(null),
  };
}

describe('the phone slip paper', () => {
  test('saves a pick at once and prints a test page on it', async () => {
    h = await openRepairScreenHarness(91);
    ensureRepairCatalog();
    const printing = fakePrinting();
    const runtime = { ...repairRuntimeFor(h, h.storeOwnerId), printing };
    const screen = render(
      <RepairRuntimeProvider runtime={runtime}>
        <PaperScreen chrome={{ syncChip: null, avatar: null }} onClose={vi.fn()} />
      </RepairRuntimeProvider>,
    );
    await settle();
    await press(screen, 'repair.paper.choice.a5');
    expect(printing.saved.at(-1)?.preset).toBe('a5');

    await press(screen, 'repair.paper.test');
    for (let i = 0; i < 50 && vi.mocked(printing.output).mock.calls.length === 0; i += 1) {
      await settle();
    }
    expect(printing.output).toHaveBeenCalledTimes(1);
    const [slip, how] = vi.mocked(printing.output).mock.calls[0]!;
    expect(how).toBe('print');
    expect(slip.paper.preset).toBe('a5');
    expect(screen.query('repair.paper.error')).toBeNull();
  });

  test('saves a size as it is typed, and keeps the last good one when it is out of range', async () => {
    h = await openRepairScreenHarness(94);
    ensureRepairCatalog();
    const printing = fakePrinting();
    const runtime = { ...repairRuntimeFor(h, h.storeOwnerId), printing };
    const screen = render(
      <RepairRuntimeProvider runtime={runtime}>
        <PaperScreen chrome={{ syncChip: null, avatar: null }} onClose={vi.fn()} />
      </RepairRuntimeProvider>,
    );
    await settle();
    // It starts from the paper it had, A4.
    await press(screen, 'repair.paper.choice.custom');
    expect(printing.saved.at(-1)).toMatchObject({ preset: 'custom', widthMm: 210, heightMm: 297 });

    typeInto(screen, 'repair.paper.size.width', '216');
    // No field is left: the counter types the last digit and presses back, and the size stays.
    typeInto(screen, 'repair.paper.size.height', '140');
    await settle();
    expect(printing.saved.at(-1)).toEqual({
      preset: 'custom',
      widthMm: 216,
      heightMm: 140,
      continuous: false,
      carbonless: false,
    });

    const before = printing.saved.length;
    typeInto(screen, 'repair.paper.size.width', '30');
    await settle();
    // Not red while it could still be the start of a good number.
    expect(screen.get('repair.paper.size.range').props.style).not.toContainEqual({
      color: color.danger,
    });
    fire(screen.get('repair.paper.size.width.field'), 'onBlur');
    await settle();
    expect(printing.saved).toHaveLength(before);
    expect(screen.get('repair.paper.size.range').props.style).toContainEqual({
      color: color.danger,
    });

    // A number already too big shows at once.
    typeInto(screen, 'repair.paper.size.height', '999');
    await settle();
    expect(printing.saved).toHaveLength(before);
    expect(screen.get('repair.paper.size.height.field').props.value).toBe('999');
  });
});
