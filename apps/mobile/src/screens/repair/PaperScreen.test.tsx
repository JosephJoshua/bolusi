// The phone's slip paper in Settings: picked once and saved at once, with a test page through the
// phone's print dialog to check it before a customer's slip goes on it.
import type { PaperSettings } from '@bolusi/core';
import {
  PaperScreen,
  RepairRuntimeProvider,
  type RepairPrinting,
} from '@bolusi/modules/repair/screens';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  ensureRepairCatalog,
  openRepairScreenHarness,
  press,
  render,
  repairRuntimeFor,
  settle,
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
});
