// The query runtime's own check of the data a handler reads (query/reads-here.ts): every table a
// statement touches, joins and subqueries included, and no table hidden in raw SQL.
import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { describe, expect, test } from 'vitest';

import { RawTableReadError, ReadNotHereError, ReadsHerePlugin } from '../../src/index.js';
import { openMemoryDriver } from '@bolusi/sqlite-test-driver';
import { createClientDialect } from '@bolusi/db-client';

interface Db {
  servisan: { id: string };
  payments: { id: string; servisanId: string; amount: number };
  catalog: { id: string };
}

const TABLE_READS = new Map<string, string | null>([
  ['servisan', 'repair.read'],
  ['payments', 'money.read'],
  ['catalog', null],
]);

async function open(here: (read: string) => boolean) {
  const driver = openMemoryDriver();
  const db = new Kysely<Db>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin()],
  });
  await sql`CREATE TABLE servisan (id TEXT)`.execute(db);
  await sql`CREATE TABLE payments (id TEXT, servisan_id TEXT, amount INTEGER)`.execute(db);
  await sql`CREATE TABLE catalog (id TEXT)`.execute(db);
  return db.withPlugin(new ReadsHerePlugin(TABLE_READS, here));
}

describe('a statement touching data that is not here', () => {
  test('is stopped before it runs, through a join or a subquery as much as a plain read', async () => {
    const db = await open((read) => read !== 'money.read');
    await expect(db.selectFrom('servisan').selectAll().execute()).resolves.toEqual([]);
    await expect(db.selectFrom('catalog').selectAll().execute()).resolves.toEqual([]);
    await expect(
      db
        .selectFrom('servisan')
        .innerJoin('payments', 'payments.servisanId', 'servisan.id')
        .selectAll()
        .execute(),
    ).rejects.toBeInstanceOf(ReadNotHereError);
    await expect(
      db
        .selectFrom('servisan')
        .select((eb) =>
          eb
            .selectFrom('payments')
            .select('amount')
            .whereRef('payments.servisanId', '=', 'servisan.id')
            .as('paid'),
        )
        .execute(),
    ).rejects.toMatchObject({ table: 'payments', read: 'money.read' });
  });

  test('a table named in raw SQL is refused, wherever the data is', async () => {
    const db = await open(() => true);
    await expect(
      db
        .selectFrom('servisan')
        .select(
          sql<number>`(SELECT SUM(amount) FROM payments WHERE servisan_id = servisan.id)`.as(
            'paid',
          ),
        )
        .execute(),
    ).rejects.toBeInstanceOf(RawTableReadError);
    await expect(
      db
        .selectFrom('servisan')
        .select(sql<number>`COALESCE(NULL, 0)`.as('zero'))
        .execute(),
    ).resolves.toEqual([]);
  });
});
