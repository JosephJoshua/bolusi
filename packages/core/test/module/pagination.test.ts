// Cursor-pagination property test (04-module-contract §6; testing-guide T-6).
//
// THE PROPERTY: walking pages with an arbitrary limit, following `nextCursor`, yields the full
// result set EXACTLY ONCE — no duplicates, no omissions — in the declared sort order, terminating
// with `nextCursor: null`.
//
// Why a property test and not examples: the bugs cursor pagination actually has are all boundary
// bugs (an off-by-one at the page edge, a non-total sort order splitting equal timestamps, a `>`
// that should be `>=`), and they only appear at specific (rowCount, limit) combinations nobody
// thinks to write down. Random limits over random row counts find them; a hand-picked
// "20 rows, limit 5" does not.
//
// DETERMINISM (T-6): every case is driven by a fixed seed, the seed is printed on failure, and the
// harness's clock and id source are seeded — so a red run is reproducible from the seed alone.
import { describe, expect, test } from 'vitest';

import {
  mulberry32,
  randomInt,
  type FixtureItemRow,
  type ListItemsInput,
} from '@bolusi/test-support';

import type { CommandContext } from '../../src/index.js';
import { openModuleHarness, type ModuleHarness } from './_harness.js';

/** Walk every page, following `nextCursor`, and return the rows in delivery order. */
async function walkPages(
  harness: ModuleHarness,
  userId: string,
  sort: ListItemsInput['sort'],
  nextLimit: () => number,
): Promise<{ rows: FixtureItemRow[]; pages: number }> {
  const rows: FixtureItemRow[] = [];
  let cursor: string | undefined;
  let pages = 0;

  for (;;) {
    const input: Partial<ListItemsInput> = {
      sort,
      limit: nextLimit(),
      ...(cursor === undefined ? {} : { cursor }),
    };
    const page = (await harness.queries.execute(
      harness.module.queries!.listItems as never,
      input as never,
      {
        tenantId: harness.tenantId,
        storeId: harness.storeId,
        userId,
        deviceId: harness.deviceId,
      },
    )) as { rows: readonly FixtureItemRow[]; nextCursor: string | null };

    rows.push(...page.rows);
    pages += 1;
    if (page.nextCursor === null) return { rows, pages };
    cursor = page.nextCursor;

    // A walk that never terminates is the failure mode a cursor bug produces (a cursor that
    // restarts from page one loops forever). Bound it rather than hanging the suite: the ceiling is
    // far above any legitimate walk of this fixture.
    if (pages > 1_000) throw new Error('page walk did not terminate — cursor is not advancing');
  }
}

/** Seed the projection with `count` items, via the REAL command path. */
async function seedItems(harness: ModuleHarness, count: number, tag: string): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const ctx: CommandContext = harness.commands.createContext(harness.adminId);
    await harness.commands.execute(
      harness.module.commands!.createItem as never,
      { label: `${tag}-${i}`, secretNote: `secret-${tag}-${i}` } as never,
      ctx,
    );
    // Advance the clock only SOMETIMES, so multiple rows deliberately share a `createdAt`. That is
    // what forces the id tiebreaker to carry the order — without ties, a non-total sort order would
    // pass this whole suite and then lose rows in production the first time two items landed in the
    // same millisecond (which, on a fast device, is routine).
    if (i % 3 !== 0) harness.advanceClock(1_000);
  }
}

describe('cursor pagination property (04 §6)', () => {
  // Fixed seeds — each is a case, and a failure names the seed that produced it.
  test.each([11, 23, 47, 101, 233])(
    'walking with random limits yields every row exactly once, in order [seed %i]',
    async (seed) => {
      const harness = await openModuleHarness(seed);
      try {
        const prng = mulberry32(seed);
        const rowCount = randomInt(prng, 1, 60);
        await seedItems(harness, rowCount, `s${seed}`);

        // The full expected set, read in one page (limit 100 >= any rowCount here).
        const whole = (await harness.queries.execute(
          harness.module.queries!.listItems as never,
          { sort: 'createdAt.desc', limit: 100 } as never,
          {
            tenantId: harness.tenantId,
            storeId: harness.storeId,
            userId: harness.adminId,
            deviceId: harness.deviceId,
          },
        )) as { rows: readonly FixtureItemRow[]; nextCursor: string | null };

        // DENOMINATOR (T-14/T-14b): the fixture really contains what we are about to page through.
        // Without this, a walk over an empty table trivially "contains every row exactly once".
        expect(whole.rows).toHaveLength(rowCount);
        expect(rowCount).toBeGreaterThan(0);

        const walked = await walkPages(harness, harness.adminId, 'createdAt.desc', () =>
          randomInt(prng, 1, 100),
        );

        const walkedIds = walked.rows.map((row) => row.id);
        const wholeIds = whole.rows.map((row) => row.id);

        // No duplicates...
        expect(new Set(walkedIds).size).toBe(walkedIds.length);
        // ...no omissions, and the SAME ORDER as the single-page read.
        expect(walkedIds).toEqual(wholeIds);
      } finally {
        await harness.close();
      }
    },
  );

  test.each([13, 29])('the same property holds ascending [seed %i]', async (seed) => {
    // The sort is part of the cursor and part of the keyset comparison. A `<`/`>` mix-up shows up
    // in exactly one direction, so both are walked.
    const harness = await openModuleHarness(seed);
    try {
      const prng = mulberry32(seed);
      const rowCount = randomInt(prng, 2, 40);
      await seedItems(harness, rowCount, `a${seed}`);

      const whole = (await harness.queries.execute(
        harness.module.queries!.listItems as never,
        { sort: 'createdAt.asc', limit: 100 } as never,
        {
          tenantId: harness.tenantId,
          storeId: harness.storeId,
          userId: harness.adminId,
          deviceId: harness.deviceId,
        },
      )) as { rows: readonly FixtureItemRow[]; nextCursor: string | null };
      expect(whole.rows).toHaveLength(rowCount);

      const walked = await walkPages(harness, harness.adminId, 'createdAt.asc', () =>
        randomInt(prng, 1, 100),
      );

      expect(walked.rows.map((r) => r.id)).toEqual(whole.rows.map((r) => r.id));
    } finally {
      await harness.close();
    }
  });

  test('limit 1 walks the whole list one row at a time and terminates', async () => {
    // The worst-case boundary: every page is a page edge, so an off-by-one at the boundary shows up
    // on every single step rather than occasionally.
    const harness = await openModuleHarness(311);
    try {
      await seedItems(harness, 7, 'one-at-a-time');

      const walked = await walkPages(harness, harness.adminId, 'createdAt.desc', () => 1);

      expect(walked.rows).toHaveLength(7);
      expect(new Set(walked.rows.map((r) => r.id)).size).toBe(7);
      expect(walked.pages).toBe(7);
    } finally {
      await harness.close();
    }
  });

  test('the last page reports nextCursor: null rather than an empty extra page', async () => {
    // The `limit + 1` fetch exists for this: without it, the last full page returns a cursor that
    // yields an empty page — technically correct, and it makes every client do one wasted round
    // trip and re-derive "empty means done".
    const harness = await openModuleHarness(312);
    try {
      await seedItems(harness, 4, 'exact-fit');

      const page = (await harness.queries.execute(
        harness.module.queries!.listItems as never,
        { sort: 'createdAt.desc', limit: 4 } as never,
        {
          tenantId: harness.tenantId,
          storeId: harness.storeId,
          userId: harness.adminId,
          deviceId: harness.deviceId,
        },
      )) as { rows: readonly FixtureItemRow[]; nextCursor: string | null };

      expect(page.rows).toHaveLength(4);
      expect(page.nextCursor).toBeNull();
    } finally {
      await harness.close();
    }
  });

  test('rows sharing a createdAt are still ordered totally — the id tiebreaker carries it', async () => {
    // Ties are the reason the sort key is `(createdAt, id)` and not `createdAt`. With every row on
    // the SAME timestamp, any page boundary lands between tied rows — so if the tiebreaker were
    // missing, this walk would drop or repeat rows.
    const harness = await openModuleHarness(313);
    try {
      for (let i = 0; i < 9; i += 1) {
        const ctx: CommandContext = harness.commands.createContext(harness.adminId);
        await harness.commands.execute(
          harness.module.commands!.createItem as never,
          { label: `tied-${i}`, secretNote: `s-${i}` } as never,
          ctx,
        );
        // NB: the clock never advances — all 9 rows share one createdAt.
      }

      const walked = await walkPages(harness, harness.adminId, 'createdAt.desc', () => 2);

      expect(walked.rows).toHaveLength(9);
      expect(new Set(walked.rows.map((r) => r.id)).size).toBe(9);
    } finally {
      await harness.close();
    }
  });
});
