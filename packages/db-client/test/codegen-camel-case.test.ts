// The inverse-mapping gate for the camelCase contract (10-db §11.4).
//
// Codegen proves the FORWARD direction (column → property). Nothing proved the INVERSE
// (property → column) until this file, and the inverse is where the bug lives:
// kysely-codegen turns `op_a_id` into `opAId`, but CamelCasePlugin's DEFAULT options turn
// `opAId` back into `op_aid` — a column that does not exist. The generated type name is
// correct and identical on both engines, so comparing type names can never catch it.
// (Found on the server side by impl-05-dbserver against the Postgres catalog; the same
// defect was live here.)
//
// So: for EVERY property of EVERY generated table, run a real query through the real
// plugin against the real migrated schema. A property that maps to a non-existent column
// fails here instead of at the first applier that touches the table.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, expect, test } from 'vitest';
import type { Kysely } from 'kysely';

import { closeClientDb, openClientDb, type ClientDb } from '../src/connection.js';
import { runClientMigrations } from '../src/migrations/runner.js';
import { openBetterSqlite3Driver } from './better-sqlite3-adapter.js';

const generatedPath = join(dirname(fileURLToPath(import.meta.url)), '../src/generated/db.ts');

/** interface name → property names, parsed from the committed codegen output. */
function parseInterfaces(source: string): Map<string, string[]> {
  const interfaces = new Map<string, string[]>();
  for (const match of source.matchAll(/export interface (\w+) \{\n([\s\S]*?)\n\}/g)) {
    const [, name, body] = match;
    const properties = [...(body ?? '').matchAll(/^ {2}(\w+):/gm)].map((m) => m[1] as string);
    interfaces.set(name as string, properties);
  }
  return interfaces;
}

/** DB interface rows: table key → interface name. */
function parseTableMap(interfaceBody: string): [string, string][] {
  return [...interfaceBody.matchAll(/^ {2}(\w+): (\w+);/gm)].map(
    (m) => [m[1] as string, m[2] as string] as [string, string],
  );
}

let connection: ClientDb;

beforeAll(async () => {
  connection = await openClientDb({
    driverFactory: openBetterSqlite3Driver,
    keyStore: { getDatabaseEncryptionKey: () => Promise.resolve('test-key') },
    location: ':memory:',
  });
  await runClientMigrations(connection.driver, { now: () => 1 });
});

afterAll(async () => {
  await closeClientDb();
});

const source = readFileSync(generatedPath, 'utf8');
const interfaces = parseInterfaces(source);
const dbBody = /export interface DB \{\n([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
const tableMap = parseTableMap(dbBody);

test('the generated types were parsed (guards the parser itself)', () => {
  // A silently-empty parse would make every case below vacuously pass.
  expect(tableMap.length).toBe(19);
  for (const [, interfaceName] of tableMap) {
    expect(interfaces.get(interfaceName)?.length ?? 0).toBeGreaterThan(0);
  }
});

test.each(tableMap)(
  'every generated property of %s maps to a real column',
  async (tableKey, interfaceName) => {
    // Loosely typed on purpose: this test drives the table/column names discovered from
    // the generated file, which the static ClientDatabase type cannot express generically.
    const db = connection.db as unknown as Kysely<Record<string, Record<string, unknown>>>;
    const properties = interfaces.get(interfaceName) ?? [];

    for (const property of properties) {
      // limit(0): we are asserting the compiled column resolves, not reading data.
      // CamelCasePlugin turns `property` into a column name here — that is the step
      // under test. A bad mapping throws "no such column".
      await expect(
        db.selectFrom(tableKey).select(property).limit(0).execute(),
        `${tableKey}.${property} must map to an existing column`,
      ).resolves.toEqual([]);
    }
  },
);

test('conflicts.opAId / opBId map to op_a_id / op_b_id, not op_aid / op_bid', async () => {
  // The specific regression, pinned by name: a single-letter segment between camel humps
  // is the shape that breaks under CamelCasePlugin's defaults. Nothing else in 10-db §9
  // has it today, so an option "simplification" would go unnoticed without this test.
  const compiled = connection.db.selectFrom('conflicts').select(['opAId', 'opBId']).compile();

  expect(compiled.sql).toContain('"op_a_id"');
  expect(compiled.sql).toContain('"op_b_id"');
  expect(compiled.sql).not.toContain('op_aid');
  expect(compiled.sql).not.toContain('op_bid');

  // ...and end-to-end against the real schema.
  await connection.db
    .insertInto('conflicts')
    .values({
      id: 'conflict-1',
      tenantId: 'tenant-1',
      entityType: 'note',
      entityId: 'note-1',
      conflictKey: 'body',
      severity: 'minor',
      status: 'detected',
      opAId: 'op-a',
      opBId: 'op-b',
      detectedAt: 1,
    })
    .execute();

  const viaKysely = await connection.db
    .selectFrom('conflicts')
    .select(['opAId', 'opBId'])
    .execute();
  expect(viaKysely).toEqual([{ opAId: 'op-a', opBId: 'op-b' }]);

  // Raw driver confirms the bytes really landed in the spec's snake_case columns.
  const raw = await connection.driver.execute(`SELECT op_a_id, op_b_id FROM conflicts`);
  expect(raw.rows).toEqual([{ op_a_id: 'op-a', op_b_id: 'op-b' }]);
});
