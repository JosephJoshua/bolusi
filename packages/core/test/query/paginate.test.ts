// The keyset-pagination helpers (04 §6) — the shared implementation of the "One MORE than asked"
// contract and the tuple-comparison predicate, extracted from three hand-rolled copies (auth
// denials, platform conflicts, notes). The load-bearing assertions: the LAST page's nextCursor is
// null (never a cursor that yields an empty page), and the predicate's page boundary neither drops
// nor repeats a row that shares a timestamp with the boundary row.
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor } from '../../src/query/cursor.js';
import { fetchKeysetPage, keysetPredicate } from '../../src/query/paginate.js';

interface Row {
  readonly id: string;
  readonly createdAt: number;
}

const rows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `id-${String(i).padStart(3, '0')}`,
    createdAt: 1000 + i,
  }));

describe('fetchKeysetPage', () => {
  it('asks for one more row than the limit', async () => {
    let asked = 0;
    await fetchKeysetPage<Row>({
      fetch: (limitPlusOne) => {
        asked = limitPlusOne;
        return Promise.resolve([]);
      },
      limit: 20,
      sort: 'createdAt.desc',
      cursorValues: (last) => [last.createdAt, last.id],
    });
    expect(asked).toBe(21);
  });

  it('slices the sentinel row off a full page and emits a decodable nextCursor', async () => {
    const { rows: page, nextCursor } = await fetchKeysetPage<Row>({
      fetch: () => Promise.resolve(rows(4)),
      limit: 3,
      sort: 'createdAt.asc',
      cursorValues: (last) => [last.createdAt, last.id],
    });
    expect(page).toHaveLength(3);
    expect(nextCursor).not.toBeNull();
    // Round-trips through the codec and names the LAST DELIVERED row, not the sentinel.
    const position = decodeCursor(nextCursor as string, 'createdAt.asc');
    expect(position.values).toEqual([1002, 'id-002']);
  });

  it('returns a null nextCursor on the last page — never a cursor yielding an empty page', async () => {
    const exact = await fetchKeysetPage<Row>({
      fetch: () => Promise.resolve(rows(3)),
      limit: 3,
      sort: 'createdAt.asc',
      cursorValues: (last) => [last.createdAt, last.id],
    });
    expect(exact.rows).toHaveLength(3);
    expect(exact.nextCursor).toBeNull();

    const empty = await fetchKeysetPage<Row>({
      fetch: () => Promise.resolve([]),
      limit: 3,
      sort: 'createdAt.asc',
      cursorValues: (last) => [last.createdAt, last.id],
    });
    expect(empty.rows).toHaveLength(0);
    expect(empty.nextCursor).toBeNull();
  });
});

describe('keysetPredicate', () => {
  interface DB {
    notes: { id: string; createdAt: number; archived: number };
  }
  // Compile-only Kysely: renders SQL without a database, which is all a predicate shape needs.
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });

  const position = { sort: 'createdAt.desc', values: [1500, 'id-042'] as const };

  it('compiles to the strict/tie/tiebreak tuple comparison (descending)', () => {
    const compiled = db
      .selectFrom('notes')
      .selectAll()
      .where((eb) =>
        keysetPredicate(eb, {
          column: 'createdAt',
          idColumn: 'id',
          position,
          descending: true,
        }),
      )
      .compile();
    expect(compiled.sql).toContain('"createdAt" < ');
    expect(compiled.sql).toContain('"createdAt" = ');
    expect(compiled.sql).toContain('"id" < ');
    expect(compiled.parameters).toEqual([1500, 1500, 'id-042']);
  });

  it('flips every comparison ascending — a boundary row sharing a timestamp is neither dropped nor repeated', () => {
    const compiled = db
      .selectFrom('notes')
      .selectAll()
      .where((eb) =>
        keysetPredicate(eb, {
          column: 'createdAt',
          idColumn: 'id',
          position: { sort: 'createdAt.asc', values: [1500, 'id-042'] },
          descending: false,
        }),
      )
      .compile();
    expect(compiled.sql).toContain('"createdAt" > ');
    expect(compiled.sql).toContain('"id" > ');
    expect(compiled.parameters).toEqual([1500, 1500, 'id-042']);
  });

  it('round-trips with the codec: a page walked desc hands its cursor back into the same predicate', async () => {
    const all = rows(5).reverse(); // desc order
    const first = await fetchKeysetPage<Row>({
      fetch: (n) => Promise.resolve(all.slice(0, n)),
      limit: 2,
      sort: 'createdAt.desc',
      cursorValues: (last) => [last.createdAt, last.id],
    });
    const position2 = decodeCursor(first.nextCursor as string, 'createdAt.desc');
    expect(position2.values).toEqual([all[1]?.createdAt, all[1]?.id]);
    // The predicate accepts exactly what the codec produced — the two halves share one shape.
    const compiled = db
      .selectFrom('notes')
      .selectAll()
      .where((eb) =>
        keysetPredicate(eb, {
          column: 'createdAt',
          idColumn: 'id',
          position: position2,
          descending: true,
        }),
      )
      .compile();
    expect(compiled.parameters).toEqual([1003, 1003, 'id-003']);
  });

  it('encodeCursor/decodeCursor stay the single wire format (guard against a second codec growing here)', () => {
    const wire = encodeCursor({ sort: 's.desc', values: [1, 'a'] });
    expect(decodeCursor(wire, 's.desc').values).toEqual([1, 'a']);
  });
});
