// Least-privilege sync: a query says "Perlu internet" only for the reads it checks (core
// query/execute.ts), so each query of every module must name the reads of the data it reads. A
// query allowed by an action permission (counting cash, taking a phone in) that left them
// unnamed would answer from empty tables on a device that does not hold that data: Kas said
// "Seharusnya di laci Rp 0" offline on a store phone, and a servisan number could repeat.
import { describe, expect, test } from 'vitest';

import { ALL_MODULES } from '../src/index.js';
import { openRepairHarness } from './support/repair-harness.js';

const opReads = new Set(
  ALL_MODULES.flatMap((module) =>
    Object.values(module.operations).map((declaration) => declaration.read),
  ).filter((read): read is string => typeof read === 'string'),
);

describe('every query names the reads of the data it reads', () => {
  test('each read a query checks is one some op type is read with', () => {
    const unclear = ALL_MODULES.flatMap((module) =>
      Object.entries(module.queries ?? {}).flatMap(([name, query]) =>
        (query.reads ?? [query.permission])
          .filter((read) => !opReads.has(read))
          .map((read) => `${module.id}.${name}: ${read}`),
      ),
    );
    expect(unclear).toEqual([]);
  });

  test('the check sees real reads (the fixture is not empty)', () => {
    expect([...opReads]).toEqual(
      expect.arrayContaining(['money.read', 'repair.read', 'purchasing.buy']),
    );
  });
});

describe('a device without the data a query reads says so', () => {
  test('Kas on a store phone without the money records needs internet, never Rp 0', async () => {
    const h = await openRepairHarness(4501, undefined, {
      readHere: (read) => read !== 'money.read',
    });
    try {
      await expect(h.moneyQuery('cashDrawer', {}, h.cashierId)).rejects.toMatchObject({
        code: 'NOT_ON_DEVICE',
      });
    } finally {
      await h.close();
    }
  });

  test('a new servisan number is not counted from servisan that are not here', async () => {
    const h = await openRepairHarness(4502, undefined, {
      readHere: (read) => read !== 'repair.read',
    });
    try {
      await expect(
        h.query('nextTicketCounter', { deviceId: 'device-1' }, h.cashierId),
      ).rejects.toMatchObject({ code: 'NOT_ON_DEVICE' });
    } finally {
      await h.close();
    }
  });
});
