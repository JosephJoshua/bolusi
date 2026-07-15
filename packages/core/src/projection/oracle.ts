// The convergence oracle (testing-guide §3.4) — defined ONCE; every convergence assertion
// uses it. Engine-neutral, byte-exact: it dumps a module's projection tables to a single
// SHA-256 digest so two projections converge iff their digests are byte-equal.
//
// The steps are normative (testing-guide §3.4):
//  1. Tables = the module's manifest tables, ascending byte order of table NAME.
//  2. Per table: SELECT the manifest-declared columns in DECLARATION order, all rows,
//     NO SQL ORDER BY (collation differs across engines — sorting happens in JS).
//  3. Normalize each scalar (see `normalizeScalar`).
//  4. Each row → JCS([tableName, v1, …, vn]) via the SAME implementation ops use (05 §3).
//  5. Sort all row-lines ascending by UTF-8 BYTE order; digest = SHA-256(join(lines,"\n")+"\n").
//
// Excluded by construction (§3.4): the op log, watermark tables, all sync bookkeeping,
// SyncState, quarantined_ops — a module manifest declares only its projection tables, so the
// oracle never sees the rest.
import { sql, type Kysely } from 'kysely';

import { bytesToHex, utf8ToBytes } from '../crypto/bytes.js';
import { canonicalizeJcs, type JsonValue } from '../crypto/jcs.js';
import {
  declaredColumns,
  type ModuleProjectionManifest,
  type ProjectionColumnType,
  type ProjectionTableManifest,
} from './manifest.js';

/** SHA-256 over raw bytes → raw bytes (the injected `CryptoPort.sha256`, 08 §3.2). */
export type HashFn = (data: Uint8Array) => Uint8Array;

/**
 * A scalar a projection column can return. The SQLite shim yields `string | number | null |
 * Uint8Array`; `boolean` and `bigint` cover the Postgres driver (true/false, and int8-as-bigint
 * when a driver is configured to return it) so the normalization table is complete on both.
 */
export type DbScalar = string | number | boolean | bigint | null | Uint8Array;

/**
 * A projection value the oracle refuses to digest. The prime case is a non-integer numeric
 * in a projection column — floats are banned from projections (05 §3), and the oracle is the
 * enforcement point (testing-guide §3.4). A float silently digested would let two divergent
 * projections read as equal, so this throws rather than coercing.
 */
export class OracleError extends Error {
  override readonly name = 'OracleError';
  /** `table.column` the offending value sits in. */
  readonly location: string;
  constructor(location: string, detail: string) {
    super(`oracle rejected ${location}: ${detail}`);
    this.location = location;
  }
}

/** 2^53 − 1, the largest integer JS `number` represents exactly (JSON safe-integer bound). */
const MAX_SAFE = 9007199254740991n;

function normalizeInteger(value: DbScalar, location: string): JsonValue {
  if (typeof value === 'bigint') {
    // A path kept for Postgres int8-as-bigint; unreachable through the SQLite shim today.
    return value <= MAX_SAFE && value >= -MAX_SAFE ? Number(value) : value.toString();
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new OracleError(location, `non-integer numeric ${value} — floats are banned (05 §3)`);
    }
    // A JS integer number is exact ⇒ within the safe range; a value above it would already be
    // lossy, so we render its decimal form (best effort) per §3.4.
    return Math.abs(value) > Number(MAX_SAFE) ? value.toString() : value;
  }
  if (typeof value === 'string') {
    // Postgres returns int8 as a string (§3.4). Must be a pure integer literal.
    if (!/^-?\d+$/.test(value)) {
      throw new OracleError(location, `integer column holds a non-integer string ${value}`);
    }
    const big = BigInt(value);
    return big <= MAX_SAFE && big >= -MAX_SAFE ? Number(big) : value;
  }
  throw new OracleError(location, `integer column holds a ${typeof value}`);
}

/**
 * Normalize one stored scalar to its canonical JSON form (testing-guide §3.4 table). Pure —
 * unit-tested directly (oracle.test.ts) so each normalization CLASS (T-12) is exercised, not
 * only the values that happen to flow through a fixture DB.
 */
export function normalizeScalar(
  value: DbScalar,
  type: ProjectionColumnType,
  location = '<value>',
): JsonValue {
  if (value === null) return null;
  switch (type) {
    case 'text':
      if (typeof value === 'string') return value;
      throw new OracleError(location, `text column holds a ${typeof value}`);
    case 'integer':
      return normalizeInteger(value, location);
    case 'boolean':
      // SQLite stores 0/1 (number); Postgres returns true/false. Both normalize to 1/0.
      if (value === true || value === 1) return 1;
      if (value === false || value === 0) return 0;
      throw new OracleError(location, `boolean column holds ${String(value)} (expected 0/1)`);
    case 'blob':
      if (value instanceof Uint8Array) return `0x${bytesToHex(value)}`;
      throw new OracleError(location, `blob column holds a ${typeof value}`);
  }
}

/** Lexicographic comparison of two strings by their UTF-8 bytes (testing-guide §3.4 step 5). */
function compareUtf8(a: string, b: string): number {
  const ab = utf8ToBytes(a);
  const bb = utf8ToBytes(b);
  const n = Math.min(ab.length, bb.length);
  for (let i = 0; i < n; i += 1) {
    const x = ab[i] as number;
    const y = bb[i] as number;
    if (x !== y) return x - y;
  }
  return ab.length - bb.length;
}

/** The physical columns a table actually has (SQLite `pragma_table_info`), for T-14 checks. */
async function readTableColumns<DB>(db: Kysely<DB>, table: string): Promise<string[]> {
  const result = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info(${table})
  `.execute(db);
  return result.rows.map((r) => r.name);
}

/**
 * Assert a table's manifest declares EXACTLY its physical columns (T-14: a coverage check
 * names its own denominator). An undeclared column is a review failure (04 §4.4) — the oracle
 * would silently skip it and two projections differing only there would read as equal. SQLite
 * only for now (uses `pragma_table_info`); the Postgres leg lands with the server (task 16).
 */
export async function assertManifestColumnsComplete<DB>(
  db: Kysely<DB>,
  tableName: string,
  table: ProjectionTableManifest,
): Promise<void> {
  const actual = new Set(await readTableColumns(db, tableName));
  const declared = new Set(declaredColumns(table));
  const undeclared = [...actual].filter((c) => !declared.has(c));
  const missing = [...declared].filter((c) => !actual.has(c));
  if (undeclared.length > 0 || missing.length > 0) {
    throw new OracleError(
      tableName,
      `manifest columns do not match the physical table — undeclared: [${undeclared.join(', ')}], declared-but-absent: [${missing.join(', ')}]`,
    );
  }
}

/**
 * The convergence digest of ONE module's projection (testing-guide §3.4). Byte-equal digests
 * ⇒ converged. The canonical-fold reference for an op set is a fresh DB fed all ops strictly
 * in canonical order, then `digestModule` — every convergence scenario asserts each device's
 * digest == the reference (§3.4).
 */
export async function digestModule<DB>(
  db: Kysely<DB>,
  module: ModuleProjectionManifest<DB>,
  options: { readonly hash: HashFn },
): Promise<string> {
  const tableNames = Object.keys(module.tables).sort(compareUtf8);
  const lines: string[] = [];

  for (const tableName of tableNames) {
    const table = module.tables[tableName];
    if (table === undefined) continue;
    const cols = declaredColumns(table);
    if (cols.length === 0) continue;

    // Positional aliases c0..cn keep the result keys unambiguous and CamelCasePlugin-inert.
    const projection = sql.join(cols.map((c, i) => sql`${sql.ref(c)} AS ${sql.ref(`c${i}`)}`));
    const result = await sql<Record<string, DbScalar>>`
      SELECT ${projection} FROM ${sql.table(tableName)}
    `.execute(db);

    for (const row of result.rows) {
      const cells: JsonValue[] = cols.map((c, i) => {
        const raw = row[`c${i}`];
        const columnType = table.columns[c] as ProjectionColumnType;
        return normalizeScalar(raw === undefined ? null : raw, columnType, `${tableName}.${c}`);
      });
      lines.push(canonicalizeJcs([tableName, ...cells]));
    }
  }

  lines.sort(compareUtf8);
  return bytesToHex(options.hash(utf8ToBytes(`${lines.join('\n')}\n`)));
}
