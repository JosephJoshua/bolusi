// Driver-conformance suite (testing-guide §2.3 — NORMATIVE for this suite).
//
// ONE statement set, run against an INJECTED driver handle: better-sqlite3 in CI,
// op-sqlite on device in L6. Asserting identical results on both is what licenses the
// claim "green in CI ⇒ meaningful on device". Without this suite, every CI run would be
// evidence about better-sqlite3 and nothing else.
//
// The driver handle is injected — this package imports no DB driver (08 §3.3), and the
// `@bolusi/db-client` edge below is TYPE-ONLY, so nothing here reaches a driver at runtime.
import type { DbDriver } from '@bolusi/db-client';

import { assertEqual, assertRejectsWithCode, ConformanceFailure } from './assert.js';

/** Opens a FRESH, empty database. Called once per case so a failure cannot cascade. */
export type ConformanceDriverFactory = () => Promise<DbDriver>;

export interface DriverConformanceCase {
  readonly name: string;
  run(driver: DbDriver): Promise<void>;
}

export interface DriverConformanceResult {
  readonly case: string;
  readonly passed: boolean;
  /** Failure detail, or `null` when the case passed. */
  readonly detail: string | null;
}

const SETUP = `CREATE TABLE conformance (
  id  INTEGER PRIMARY KEY,
  i   INTEGER,
  r   REAL,
  t   TEXT,
  n   TEXT,
  b   BLOB
)`;

const INSERT = `INSERT INTO conformance (id, i, r, t, n, b) VALUES (?, ?, ?, ?, ?, ?)`;

async function countRows(driver: DbDriver): Promise<number> {
  const result = await driver.execute(`SELECT COUNT(*) AS c FROM conformance`);
  return Number(result.rows[0]?.['c']);
}

export const DRIVER_CONFORMANCE_CASES: readonly DriverConformanceCase[] = [
  {
    // Every SQLite storage class the op log and projections actually use (10-db §9).
    // Blobs are the trap: better-sqlite3 yields Buffer, op-sqlite yields ArrayBuffer —
    // both adapters must normalize, or "identical results" is false.
    name: 'types round-trip: INTEGER / REAL / TEXT / NULL / blob',
    async run(driver) {
      await driver.execute(SETUP);
      const blob = new Uint8Array([0, 1, 2, 254, 255]);
      const result = await driver.execute(INSERT, [1, 42, 1.5, 'text', null, blob]);
      assertEqual(result.rowsAffected, 1, 'insert rowsAffected');
      assertEqual(result.insertId, 1, 'insert insertId');

      const rows = await driver.execute(`SELECT id, i, r, t, n, b FROM conformance`);
      assertEqual(
        rows.rows,
        [{ id: 1, i: 42, r: 1.5, t: 'text', n: null, b: new Uint8Array([0, 1, 2, 254, 255]) }],
        'round-tripped row',
      );
    },
  },
  {
    name: 'transaction commit persists writes',
    async run(driver) {
      await driver.execute(SETUP);
      await driver.begin();
      await driver.execute(INSERT, [1, 1, 1, 'committed', null, null]);
      await driver.commit();
      assertEqual(await countRows(driver), 1, 'row count after commit');
    },
  },
  {
    name: 'transaction rollback discards writes',
    async run(driver) {
      await driver.execute(SETUP);
      await driver.execute(INSERT, [1, 1, 1, 'kept', null, null]);
      await driver.begin();
      await driver.execute(INSERT, [2, 2, 2, 'discarded', null, null]);
      assertEqual(await countRows(driver), 2, 'row count inside the transaction');
      await driver.rollback();
      assertEqual(await countRows(driver), 1, 'row count after rollback');

      const rows = await driver.execute(`SELECT t FROM conformance`);
      assertEqual(rows.rows, [{ t: 'kept' }], 'surviving row after rollback');
    },
  },
  {
    name: 'prepared statement reuse: bind and execute repeatedly',
    async run(driver) {
      await driver.execute(SETUP);
      const insert = driver.prepare(INSERT);
      for (let id = 1; id <= 3; id += 1) {
        const result = await insert.execute([id, id * 10, id / 2, `row-${id}`, null, null]);
        assertEqual(result.rowsAffected, 1, `prepared insert ${id} rowsAffected`);
      }
      await insert.finalize();

      // A reused SELECT must give the same answer on every execution, not just the first.
      const select = driver.prepare(`SELECT i FROM conformance WHERE id = ?`);
      assertEqual((await select.execute([2])).rows, [{ i: 20 }], 'first prepared select');
      assertEqual((await select.execute([2])).rows, [{ i: 20 }], 'second prepared select');
      assertEqual((await select.execute([3])).rows, [{ i: 30 }], 're-bound prepared select');
      await select.finalize();

      const all = await driver.execute(`SELECT t FROM conformance ORDER BY id`);
      assertEqual(
        all.rows,
        [{ t: 'row-1' }, { t: 'row-2' }, { t: 'row-3' }],
        'rows written by the reused statement',
      );
    },
  },
  {
    name: 'batch insert applies every command',
    async run(driver) {
      await driver.execute(SETUP);
      const result = await driver.executeBatch([
        [INSERT, [1, 1, 1, 'a', null, null]],
        [INSERT, [2, 2, 2, 'b', null, null]],
        [INSERT, [3, 3, 3, 'c', null, null]],
      ]);
      assertEqual(result.rowsAffected, 3, 'batch rowsAffected');

      const rows = await driver.execute(`SELECT t FROM conformance ORDER BY id`);
      assertEqual(rows.rows, [{ t: 'a' }, { t: 'b' }, { t: 'c' }], 'rows written by the batch');
    },
  },
  {
    name: 'batch is atomic: a failing command rolls the whole batch back',
    async run(driver) {
      await driver.execute(SETUP);
      await assertRejectsWithCode(
        () =>
          driver.executeBatch([
            [INSERT, [1, 1, 1, 'a', null, null]],
            // Duplicate primary key — the batch must not leave the first row behind.
            [INSERT, [1, 2, 2, 'b', null, null]],
          ]),
        'constraint',
        'failing batch',
      );
      assertEqual(await countRows(driver), 0, 'row count after a failed batch');
    },
  },
  {
    name: 'error mapping: constraint / no_such_table / syntax',
    async run(driver) {
      await driver.execute(SETUP);
      await driver.execute(INSERT, [1, 1, 1, 'a', null, null]);

      await assertRejectsWithCode(
        () => driver.execute(INSERT, [1, 2, 2, 'duplicate', null, null]),
        'constraint',
        'duplicate primary key',
      );
      await assertRejectsWithCode(
        () => driver.execute(`SELECT * FROM does_not_exist`),
        'no_such_table',
        'missing table',
      );
      await assertRejectsWithCode(
        () => driver.execute(`SELCT bogus FROM conformance`),
        'syntax',
        'malformed SQL',
      );
    },
  },
  {
    name: 'error mapping: CHECK constraints reject out-of-enum values',
    async run(driver) {
      // Mirrors the shape 10-db §9.2 relies on for `operations.source`.
      await driver.execute(`CREATE TABLE checked (s TEXT NOT NULL CHECK (s IN ('ui','agent')))`);
      await driver.execute(`INSERT INTO checked (s) VALUES (?)`, ['ui']);
      await assertRejectsWithCode(
        () => driver.execute(`INSERT INTO checked (s) VALUES (?)`, ['bogus']),
        'constraint',
        'value outside the CHECK enum',
      );
    },
  },
];

/**
 * Runs the whole set against one injected driver and reports per-case results.
 *
 * Results are returned rather than asserted so both runners can consume them: vitest in
 * CI, and the L6 Harness screen which emits them as JSON to logcat (testing-guide §2.6).
 */
export async function runDriverConformance(
  openDriver: ConformanceDriverFactory,
): Promise<DriverConformanceResult[]> {
  const results: DriverConformanceResult[] = [];

  for (const testCase of DRIVER_CONFORMANCE_CASES) {
    let driver: DbDriver | undefined;
    try {
      driver = await openDriver();
      await testCase.run(driver);
      results.push({ case: testCase.name, passed: true, detail: null });
    } catch (error) {
      const detail =
        error instanceof ConformanceFailure || error instanceof Error
          ? error.message
          : String(error);
      results.push({ case: testCase.name, passed: false, detail });
    } finally {
      await driver?.close().catch(() => undefined);
    }
  }

  return results;
}

export { ConformanceFailure, assertEqual, assertRejectsWithCode, deepEqual } from './assert.js';
export * from './at-rest.js';
