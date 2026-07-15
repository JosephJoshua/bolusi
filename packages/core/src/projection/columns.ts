// Reading a `jsonb`/`json`-or-TEXT column and a `boolean`-or-`0/1` column, once, for the whole
// projection engine. The sibling of int8.ts, for the two other classes task 48 found in the same
// decoder.
//
// WHY THIS MODULE EXISTS RATHER THAN A `JSON.parse`/`!== 0` AT EACH CALL SITE
// ---------------------------------------------------------------------------
// Same reason as int8.ts, and found the same way: the column reads back as a DIFFERENT JS TYPE
// depending on which client opened the connection, and the engine runs against all of them
// (04 §4, 10-db §9):
//
//   column class      client SQLite (op-sqlite/better-sqlite3)  PGlite + real `pg`
//   ----------------  ----------------------------------------  ---------------------
//   payload/location  TEXT      → string (JSON text)            jsonb → PARSED value
//   agent_initiated   INTEGER   → 0 / 1                         boolean → false / true
//
// `reconstructOperation` was written against the left column only. On the right it did
// `JSON.parse(someObject)`, which throws `SyntaxError: "[object Object]" is not valid JSON`, and
// `false !== 0`, which is TRUE — so every op read back `agentInitiated: true`.
//
// The second one is why this is a module and not two inline expressions. It does not throw. It
// corrupts the fraud model's attribution (02 §7, PRD-004) in the direction that EXCUSES the human
// who acted, silently, on every op. A convention that has to be remembered at each call site is
// how `agent_initiated` and `payload` came to be wrong twelve lines apart from an int8 column that
// was ALSO wrong — three classes, one decoder, one author, all invisible (CLAUDE.md §2.8).
//
// WHY THESE REFUSE INSTEAD OF COERCING
// -------------------------------------
// int8.ts's header argues this for rounding; the same argument holds here for guessing.
//
// `row.agentInitiated !== 0` IS a coercion — the most permissive one available — and it is exactly
// what produced the bug: handed a `false` it had never considered, it answered `true` rather than
// complain. A truthiness test cannot tell "this driver says false" from "this driver says
// something I do not understand", so it answers both the same way, wrongly and quietly. Enumerating
// the shapes each driver actually produces, and throwing on anything else, turns "the driver
// marshals booleans the way I assumed" from an invisible assumption into a claim that fails loudly
// the day it stops holding — checked, on the real driver, by
// db-server/test/projection-rawoprow-marshalling.test.ts.

/** The raw shapes a JSON-bearing column arrives in, across the drivers the engine runs on. */
export type JsonColumnValue = string | object;

/** The raw shapes a boolean column arrives in: a real boolean, or SQLite's `0`/`1`. */
export type BoolColumnValue = boolean | number;

/**
 * Reads a JSON-bearing column (`jsonb` server-side, TEXT client-side) into the OBJECT it holds.
 *
 * Returns objects only, because the two columns this serves — `payload` (`z.looseObject`) and
 * `location` (`z.strictObject`) — are objects by schema (05 §2.1). That is what resolves the one
 * genuine ambiguity here: a `jsonb` column holding the JSON *string* `"hi"` hands `pg` back a JS
 * string, which is indistinguishable from the client's TEXT encoding of the same column. Rather
 * than guess which of the two it is looking at, this refuses any input that does not end at an
 * object — a shape neither column can legally hold, so the refusal costs nothing and closes the
 * ambiguity by construction.
 *
 * @param value the raw column value: `string` (client TEXT) or a parsed `object` (jsonb).
 * @param column `table.column`, used in the error — a bare parse failure is unactionable.
 * @throws when the value is not, or does not parse to, a JSON object.
 */
export function jsonColumnToObject(value: JsonColumnValue, column: string): object {
  if (typeof value === 'object') {
    // Already parsed by the driver (jsonb). `null` is not reachable through this branch: the
    // callers test for SQL NULL themselves, since a nullable column's null is THEIR business —
    // `location` is legitimately null (05 §3 absent-vs-null) and `payload` is NOT NULL.
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

/**
 * Reads a boolean column into a boolean, whatever the driver handed back.
 *
 * Deliberately NOT `value !== 0`, and not `Boolean(value)`. See this file's header: the truthiness
 * test is the bug. This enumerates and refuses the rest.
 *
 * @param value the raw column value: `boolean` (Postgres) or `0`/`1` (SQLite INTEGER).
 * @param column `table.column`, used in the error.
 * @throws when the value is neither a boolean nor exactly `0`/`1` — i.e. when a driver marshals
 *   this column in a way nobody here has verified, which is the moment to stop, not to guess.
 */
export function boolColumnToBoolean(value: BoolColumnValue, column: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 0) return false;
  if (value === 1) return true;

  throw new TypeError(
    `${column}: expected a boolean or 0/1 from a boolean column, got ${JSON.stringify(value)}. ` +
      'Coercing an unrecognised shape is what made every op read back agent-initiated (task 48).',
  );
}
