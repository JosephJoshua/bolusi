// Reading a `jsonb`-or-TEXT column, once, for every engine. The sibling of int8.ts.
//
// The same column reads back as a DIFFERENT JS TYPE depending on which client opened the connection:
// client SQLite (op-sqlite/better-sqlite3) hands back the TEXT, PGlite and real `pg` hand back the
// parsed `jsonb` value. Code written against one side does `JSON.parse(someObject)` on the other,
// which throws (task 48). Op-log reads no longer need this: they rebuild the op from its signed text,
// which is TEXT everywhere. The verifier params (auth/repo.ts) still do.
//
// It refuses instead of coercing, for int8.ts's reason: an unrecognised shape is the moment to stop,
// checked on the real driver by db-server's marshalling tests.

/** The raw shapes a JSON-bearing column arrives in, across the drivers the engine runs on. */
export type JsonColumnValue = string | object;

/**
 * Reads a JSON-bearing column (`jsonb` server-side, TEXT client-side) into the OBJECT it holds.
 *
 * Returns objects only, because the columns this serves hold objects by schema. That resolves the
 * one genuine ambiguity here: a `jsonb` column holding the JSON *string* `"hi"` hands `pg` back a JS
 * string, which is indistinguishable from the client's TEXT encoding of the same column. Rather
 * than guess which of the two it is looking at, this refuses any input that does not end at an
 * object — a shape such a column cannot legally hold, so the refusal costs nothing and closes the
 * ambiguity by construction.
 *
 * @param value the raw column value: `string` (client TEXT) or a parsed `object` (jsonb).
 * @param column `table.column`, used in the error — a bare parse failure is unactionable.
 * @throws when the value is not, or does not parse to, a JSON object.
 */
export function jsonColumnToObject(value: JsonColumnValue, column: string): object {
  if (typeof value === 'object') {
    // Already parsed by the driver (jsonb). `null` is not reachable through this branch: the
    // callers test for SQL NULL themselves, since a nullable column's null is THEIR business.
    return value;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new TypeError(`${column}: stored value is not valid JSON.`, { cause });
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new TypeError(
      `${column}: expected a JSON object, got ${parsed === null ? 'null' : typeof parsed}.`,
    );
  }
  return parsed;
}
