// Reading an `int8`/`bigint` column into a JS number, once, for the whole projection engine.
//
// WHY THIS MODULE EXISTS RATHER THAN A `Number()` AT EACH CALL SITE
// -----------------------------------------------------------------
// The same column reads back as a DIFFERENT JS TYPE depending on which client opened the
// connection — and the engine runs against all of them (04 §4, 10-db §9):
//
//   client SQLite (better-sqlite3)  int8 → number   (SQLite INTEGER is 64-bit, handed back as
//                                                    a double; lossy past 2^53 with no warning)
//   PGlite                          int8 → number   (in-process; marshals to a JS number)
//   real `pg` (production, test:rls) int8 → STRING  (int8's range exceeds JS safe integers, so
//                                                    node-postgres refuses to narrow it silently)
//   kysely/driver variants           int8 → bigint  (some configurations)
//
// Task 46 is what happens without a single seam for that: the contiguity walk (now
// `highestContiguousSeq`) asserted `sql<{ serverSeq: number }>` over the SERVER's
// `operations.server_seq` and compared `row.serverSeq ===
// watermark + 1`. On real Postgres that is `"1" === 1` → false, forever. The walk returned `from`
// unchanged and `applied_server_seq` never advanced in production. It threw nothing and failed no
// test, because every lane that existed ran a driver that hands back numbers (testing-guide T-8,
// T-14f). Twelve lines away, `watermarks.ts` DID carry the cast — one function had it, the
// neighbouring one did not. A convention that has to be remembered at each call site is exactly
// how that happens, so there is now one function and no convention (CLAUDE.md §2.8).
//
// WHY THIS THROWS PAST 2^53 INSTEAD OF COERCING (and why not oracle.ts's shape)
// -----------------------------------------------------------------------------
// `oracle.ts:59` normalises a bigint as `value <= MAX_SAFE ? Number(value) : value.toString()` —
// it can degrade to a string because its return type is `JsonValue`. That option does not exist
// here: callers need a `number` to do arithmetic with, so the only two choices are "narrow it" or
// "refuse".
//
// A plain `Number()` narrows. Past 2^53 that rounds — `Number("9007199254740993")` is
// 9007199254740992 — and a rounded watermark is a WRONG watermark returned with no error: the
// exact silent-wrong-answer failure of task 46, one magnitude up, wearing a different hat. These
// columns were deliberately typed `bigint` (10-db §5); it is not this function's place to quietly
// decide that the top of that range does not exist.
//
// So it refuses. That turns "the sequence column realistically stays under 2^53" from an assumption nobody
// can see into a CLAIM A TEST CAN CHECK — and one that is checked, on the real driver, by
// db-server/test/projection-int8-marshalling.test.ts. If the op log ever genuinely approaches
// 2^53, this throws loudly at the boundary instead of corrupting a watermark, and the fix is a
// deliberate migration to bigint arithmetic rather than an archaeology expedition.

/** 2^53 − 1: the largest integer a JS `number` represents exactly (mirrors `oracle.ts` MAX_SAFE). */
const MAX_SAFE = 9007199254740991n;

/** Only a pure decimal integer literal — what an int8 column can ever produce as a string. */
const INTEGER_LITERAL = /^-?\d+$/;

/** The raw shapes an int8 column arrives in, across the drivers the engine runs on. */
export type Int8Value = string | number | bigint;

/**
 * Reads one `int8`/`bigint` column value into an EXACT bigint, whatever the driver handed back.
 *
 * This is the lossless half, and the one to compare and accumulate with: bigint arithmetic and
 * `===` are exact over the column's whole range, so a walk can run here without deciding anything
 * about JS number range. Narrow with `int8ToNumber` only where the value actually escapes into
 * JS — usually once, at the end.
 *
 * @param value the raw column value: `string` (real `pg`), `number` (SQLite/PGlite) or `bigint`.
 * @param column `table.column`, used in the error — a bare "out of range" is unactionable.
 * @throws when the value is not an exact integer, including a `number` that the DRIVER already
 *   rounded on its way here (the rounding was not ours, but the value is no less wrong for it).
 */
export function int8ToBigInt(value: Int8Value, column: string): bigint {
  if (typeof value === 'bigint') return value;

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(
        `${column}: ${value} is not a safe integer — an int8 read came back already rounded or ` +
          'non-integral, so anything derived from it would be silently wrong (task 46).',
      );
    }
    return BigInt(value);
  }

  if (!INTEGER_LITERAL.test(value)) {
    throw new TypeError(
      `${column}: expected an integer from an int8 column, got ${JSON.stringify(value)}.`,
    );
  }
  return BigInt(value);
}

/**
 * Narrows an int8 column value to an exact JS number — the boundary where a bigint becomes
 * something the rest of the engine can do arithmetic with.
 *
 * @throws when the value is outside ±(2^53 − 1), where a JS number would silently round it.
 *   Refusing beats returning a wrong number nobody can detect — see this file's header.
 */
export function int8ToNumber(value: Int8Value, column: string): number {
  const big = int8ToBigInt(value, column);

  if (big > MAX_SAFE || big < -MAX_SAFE) {
    throw new RangeError(
      `${column}: ${big.toString()} exceeds ±(2^53 − 1), so narrowing it to a JS number would ` +
        'round it and produce a wrong value with no error. The column is bigint on purpose ' +
        '(10-db §5); this refuses rather than corrupt it (task 46).',
    );
  }
  return Number(big);
}
