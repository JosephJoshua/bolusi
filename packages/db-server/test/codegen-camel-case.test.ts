// The codegen ⇄ runtime name contract (10-db-schema §1, §11).
//
// Two independent pieces of machinery have to agree on one mapping:
//   kysely-codegen --camel-case   writes  op_a_id  →  opAId   into src/generated/db.d.ts
//   CamelCasePlugin (runtime)     maps    opAId    →  ???     back to a column
//
// If they disagree the code COMPILES (the type says opAId exists) and fails at runtime against
// a column that does not exist. That is not hypothetical: with the plugin's DEFAULT options,
// `opAId` maps to `op_aid`, so every query touching conflicts.op_a_id / op_b_id would break.
// This test re-derives the agreement over every generated property against the live catalog.
import { readFileSync } from 'node:fs';

import { CamelCasePlugin, sql } from 'kysely';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { CAMEL_CASE_OPTIONS, createCamelCasePlugin } from '../src/camel-case.js';
import { createTestDb, type TestDb } from './helpers/test-db.js';

const GENERATED = new URL('../src/generated/db.d.ts', import.meta.url);

/** The plugin's camelCase→snake_case mapper, i.e. the exact function the runtime uses. */
const toSnakeCase = (name: string): string =>
  (createCamelCasePlugin() as unknown as { snakeCase: (s: string) => string }).snakeCase(name);

/** `export interface Name {\n  prop: T;\n ... }` → { Name: [props] } */
function parseInterfaces(source: string): Map<string, string[]> {
  const interfaces = new Map<string, string[]>();
  const blocks = source.matchAll(/export interface (\w+) \{\n([\s\S]*?)\n\}/g);

  for (const [, name, body] of blocks) {
    const props = [...(body ?? '').matchAll(/^ {2}(\w+):/gm)].map((m) => m[1] as string);
    interfaces.set(name as string, props);
  }

  return interfaces;
}

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb();
}, 120_000);

afterAll(async () => {
  await testDb?.close();
});

test('every generated table property maps back to a real column', async () => {
  const source = readFileSync(GENERATED, 'utf8');
  const interfaces = parseInterfaces(source);

  const dbInterface = interfaces.get('DB');
  expect(dbInterface, 'generated db.d.ts has no DB interface').toBeDefined();

  // tableProp → InterfaceName, straight out of the DB interface.
  const tableToInterface = new Map(
    [...source.matchAll(/^ {2}(\w+): (\w+);$/gm)]
      .filter(([, prop]) => dbInterface?.includes(prop as string))
      .map(([, prop, iface]) => [prop as string, iface as string]),
  );
  expect(tableToInterface.size).toBeGreaterThan(20);

  const { rows: columns } = await sql<{ tableName: string; columnName: string }>`
    SELECT table_name AS "tableName", column_name AS "columnName"
      FROM information_schema.columns
     WHERE table_schema = 'public'
  `.execute(testDb.db);

  const actual = new Map<string, Set<string>>();
  for (const { tableName, columnName } of columns) {
    (actual.get(tableName) ?? actual.set(tableName, new Set()).get(tableName))?.add(columnName);
  }

  const mismatches: string[] = [];
  let checked = 0;

  for (const [tableProp, ifaceName] of tableToInterface) {
    const table = toSnakeCase(tableProp);
    const realColumns = actual.get(table);
    if (realColumns === undefined) {
      mismatches.push(`table ${tableProp} → ${table} (no such table)`);
      continue;
    }

    // Anti-vacuity, per interface. `parseInterfaces` is a REGEX over generated text: if
    // kysely-codegen ever changes its output shape, the parse degrades to zero properties, the
    // loop below no-ops, and this test goes green having verified nothing. An empty parse is a
    // broken test, not a passing schema — so say so out loud rather than iterating `?? []`.
    const props = interfaces.get(ifaceName) ?? [];
    expect(
      props.length,
      `${ifaceName} parsed 0 properties — the generated-type parse broke`,
    ).toBeGreaterThan(0);

    for (const prop of props) {
      const column = toSnakeCase(prop);
      checked += 1;
      if (!realColumns.has(column)) {
        mismatches.push(`${table}.${prop} → ${column} (no such column)`);
      }
    }
  }

  expect(mismatches).toEqual([]);

  // Anti-vacuity, in aggregate: the whole sweep must have actually mapped the schema. 27 tables
  // / 216 columns today; the floor is deliberately below that so ordinary schema growth does not
  // trip it, while a collapsed parse (which yields ~0) still fails loudly.
  expect(
    checked,
    'the sweep checked implausibly few properties — parse likely broke',
  ).toBeGreaterThan(150);
});

test('the generated-type parser fails loudly rather than silently matching nothing', () => {
  // Falsifies the guard above: feed the parser output shaped like a codegen format change and
  // prove it yields nothing to check, which is what the per-interface assertion now catches.
  const parsed = parseInterfaces('export interface Conflicts {\n  opAId : string;\n}\n');
  expect(parsed.get('Conflicts')).toEqual([]); // `opAId :` (space before colon) does not match

  // ...whereas the real committed file parses to real properties.
  const real = parseInterfaces(readFileSync(GENERATED, 'utf8'));
  expect(real.get('Conflicts')).toContain('opAId');
  expect((real.get('Notes') ?? []).length).toBeGreaterThan(0);
});

test('the plugin maps multi-single-letter columns like op_a_id correctly', async () => {
  // The specific shape that breaks under the default options, asserted end-to-end through the
  // real query builder rather than via the mapper in isolation.
  expect(toSnakeCase('opAId')).toBe('op_a_id');
  expect(toSnakeCase('opBId')).toBe('op_b_id');

  await expect(
    testDb.db.selectFrom('conflicts').select(['opAId', 'opBId']).execute(),
  ).resolves.toEqual([]);
});

test('the default CamelCasePlugin options would break op_a_id', () => {
  // Pins WHY the non-default option is set, so nobody "simplifies" it away. If a future kysely
  // makes this the default, this test fails and the option can be dropped deliberately.
  const defaults = new CamelCasePlugin() as unknown as { snakeCase: (s: string) => string };
  expect(defaults.snakeCase('opAId')).toBe('op_aid');
  expect(CAMEL_CASE_OPTIONS.underscoreBetweenUppercaseLetters).toBe(true);
});
