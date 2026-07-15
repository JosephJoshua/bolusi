// The custom client Kysely dialect (D6; 08 §2.2). It is built on kysely-generic-sqlite
// 2.0.0 over `DbDriver` — NEVER over op-sqlite directly. There is exactly one dialect
// implementation and two driver adapters beneath it (testing-guide §2.3); that is the
// whole reason CI's better-sqlite3 run licenses a claim about the device.
import {
  GenericSqliteDialect,
  buildQueryFn,
  defaultIsQuery,
  parseBigInt,
} from 'kysely-generic-sqlite';
import type { IGenericSqlite } from 'kysely-generic-sqlite';
import type { Dialect, RootOperationNode } from 'kysely';

import type { DbDriver, DbRow, DbValue } from '../driver.js';

/**
 * kysely-generic-sqlite's default classifier deliberately does not parse SQL: it returns
 * `false` for every RawNode, including raw `SELECT` and `PRAGMA`. Those reach us through
 * `sql\`...\`` template queries, so without this override their rows would be dropped.
 */
function isRowReturningStatement(sql: string, node: RootOperationNode | undefined): boolean {
  if (defaultIsQuery(sql, node)) return true;
  return /^\s*(?:select|pragma|with|explain|values)\b/i.test(sql);
}

/**
 * Adapts the driver to kysely-generic-sqlite's executor contract.
 *
 * `close` is intentionally inert: the connection singleton owns the driver's lifecycle
 * (`closeClientDb` closes it exactly once). Kysely's `destroy()` reaches this method, and
 * letting it close a driver that raw helpers still share would tear the connection out
 * from under them.
 */
function toGenericSqlite(driver: DbDriver): IGenericSqlite<DbDriver> {
  return {
    db: driver,
    close: () => undefined,
    query: buildQueryFn({
      isQuery: isRowReturningStatement,
      all: async (sql, parameters) => {
        const result = await driver.execute(sql, parameters as readonly DbValue[] | undefined);
        return result.rows as DbRow[];
      },
      run: async (sql, parameters) => {
        const result = await driver.execute(sql, parameters as readonly DbValue[] | undefined);
        const insertId = parseBigInt(result.insertId);
        const numAffectedRows = parseBigInt(result.rowsAffected);
        // `exactOptionalPropertyTypes` (08 §4.1) forbids assigning an explicit `undefined`
        // to an optional key — the keys are omitted instead of set to undefined.
        return {
          ...(insertId === undefined ? {} : { insertId }),
          ...(numAffectedRows === undefined ? {} : { numAffectedRows }),
          rows: result.rows as DbRow[],
        };
      },
    }),
  };
}

/**
 * Builds the Kysely dialect for an already-open driver.
 *
 * The executor factory closes over the single driver instance and hands back that exact
 * object every time — it never opens anything. The op-sqlite single-connection rule
 * (08 §2.2) is a hard constraint, so "the dialect might open its own handle" must be
 * impossible by construction, not by convention.
 */
export function createClientDialect(driver: DbDriver): Dialect {
  const executor = toGenericSqlite(driver);
  return new GenericSqliteDialect(() => executor);
}
