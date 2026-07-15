// The convergence oracle (testing-guide §3.4), item by item: declared columns in declaration
// order only; excluded tables never digested; the normalization table (NULL, >2^53−1 integer →
// decimal string, boolean 0/1, blob → lowercase hex, float → ERROR); rows sorted in JS by UTF-8
// byte order (NOT SQL, NOT UTF-16); row lines via the shared JCS.
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ClientDatabase } from '@bolusi/db-client';

import {
  assertManifestColumnsComplete,
  canonicalizeJcs,
  digestModule,
  normalizeScalar,
  OracleError,
  utf8ToBytes,
  type ModuleProjectionManifest,
} from '../index.js';
import {
  deliverPulled,
  openProjectionHarness,
  sha256,
  type ProjectionHarness,
} from '../../test/projection/db.js';
import {
  generateNotesScript,
  notesModule,
  notesTable,
} from '../../test/projection/notes-fixture.js';

let harness: ProjectionHarness;
beforeEach(async () => {
  harness = await openProjectionHarness();
});
afterEach(async () => {
  await harness.close();
});

describe('normalizeScalar — every normalization class (§3.4, T-12)', () => {
  test('null → null', () => {
    expect(normalizeScalar(null, 'text')).toBeNull();
    expect(normalizeScalar(null, 'integer')).toBeNull();
    expect(normalizeScalar(null, 'blob')).toBeNull();
  });
  test('text passes through; a non-string in a text column errors', () => {
    expect(normalizeScalar('hello', 'text')).toBe('hello');
    expect(() => normalizeScalar(5, 'text')).toThrow(OracleError);
  });
  test('integer: small values are JSON integers; > 2^53−1 → decimal string', () => {
    expect(normalizeScalar(42, 'integer')).toBe(42);
    expect(normalizeScalar('42', 'integer')).toBe(42); // pg int8-as-string, small
    expect(normalizeScalar(9007199254740993n, 'integer')).toBe('9007199254740993');
    expect(normalizeScalar('9007199254740993', 'integer')).toBe('9007199254740993');
  });
  test('boolean-declared column normalizes to 1 / 0 (SQLite 0/1 and Postgres true/false)', () => {
    expect(normalizeScalar(1, 'boolean')).toBe(1);
    expect(normalizeScalar(0, 'boolean')).toBe(0);
    expect(normalizeScalar(true, 'boolean')).toBe(1);
    expect(normalizeScalar(false, 'boolean')).toBe(0);
  });
  test('blob → "0x" + lowercase hex', () => {
    expect(normalizeScalar(new Uint8Array([0xab, 0x0f, 0x00]), 'blob')).toBe('0xab0f00');
  });
  test('a float value is an ORACLE ERROR — floats are banned from projections (05 §3)', () => {
    expect(() => normalizeScalar(1.5, 'integer')).toThrow(OracleError);
    expect(() => normalizeScalar(-0.25, 'integer')).toThrow(OracleError);
  });
});

describe('digestModule — end-to-end (§3.4)', () => {
  test('excluded tables (op log, watermarks) never change the digest', async () => {
    await deliverPulled(harness, generateNotesScript(1, { deviceCount: 2, opsPerDevice: 20 }));
    const digestBefore = await harness.digest();

    // Advancing a watermark and writing meta_kv must NOT move the digest — neither table is a
    // declared projection table, so the oracle never reads them.
    await sql`
      INSERT INTO projection_watermarks (module_id, applied_server_seq) VALUES ('notes', 999)
      ON CONFLICT (module_id) DO UPDATE SET applied_server_seq = 999
    `.execute(harness.db);
    await sql`INSERT INTO meta_kv (key, value) VALUES ('junk', 'x')
             ON CONFLICT (key) DO UPDATE SET value = 'x'`.execute(harness.db);
    expect(await harness.digest()).toBe(digestBefore);
  });

  test('a float smuggled into an integer column makes the digest throw (05 §3)', async () => {
    await deliverPulled(harness, generateNotesScript(2, { deviceCount: 1, opsPerDevice: 1 }));
    expect(await harness.digest()).toMatch(/^[0-9a-f]{64}$/); // healthy first

    // SQLite is dynamically typed: force a REAL into the INTEGER edit_count column.
    await sql`UPDATE notes SET edit_count = 1.5`.execute(harness.db);
    await expect(harness.digest()).rejects.toBeInstanceOf(OracleError);
  });

  test('the normalization table is exercised end-to-end on a probe table (NULL, boolean, blob)', async () => {
    await sql`CREATE TABLE oracle_probe (t TEXT, i INTEGER, b INTEGER, raw BLOB)`.execute(
      harness.db,
    );
    await sql`INSERT INTO oracle_probe (t, i, b, raw) VALUES ('hi', 7, 1, x'ab0f')`.execute(
      harness.db,
    );
    await sql`INSERT INTO oracle_probe (t, i, b, raw) VALUES (NULL, -3, 0, NULL)`.execute(
      harness.db,
    );

    const probe: ModuleProjectionManifest<ClientDatabase> = {
      id: 'probe',
      tables: {
        oracle_probe: {
          columns: { t: 'text', i: 'integer', b: 'boolean', raw: 'blob' },
          primaryKey: ['t'],
          entityType: 'probe',
          entityIdColumn: 't',
          projectionVersion: 1,
        },
      },
      appliers: {},
    };

    // Build the expected digest independently from the SAME normalization rules, so the test
    // asserts the exact bytes, not just "it hashed something".
    const rows = [
      canonicalizeJcs(['oracle_probe', 'hi', 7, 1, '0xab0f']),
      canonicalizeJcs(['oracle_probe', null, -3, 0, null]),
    ].sort(byUtf8);
    const expected = sha256Hex(`${rows.join('\n')}\n`);
    expect(await digestModule(harness.db, probe, { hash: sha256 })).toBe(expected);
  });

  test('row-lines are sorted by UTF-8 byte order — NOT JS-default UTF-16 (§3.4)', async () => {
    // Two text values whose order DIFFERS between UTF-8 bytes and UTF-16 code units: a
    // supplementary-plane char (U+10000, UTF-16 surrogate 0xD800…) vs a high-BMP char
    // (U+FF00). UTF-16 puts the surrogate first; UTF-8 puts U+FF00 first.
    await sql`CREATE TABLE oracle_sort (t TEXT)`.execute(harness.db);
    await sql`INSERT INTO oracle_sort (t) VALUES (${'A\u{10000}'})`.execute(harness.db);
    await sql`INSERT INTO oracle_sort (t) VALUES (${'A\uFF00'})`.execute(harness.db);

    const manifest: ModuleProjectionManifest<ClientDatabase> = {
      id: 'sortprobe',
      tables: {
        oracle_sort: {
          columns: { t: 'text' },
          primaryKey: ['t'],
          entityType: 'x',
          entityIdColumn: 't',
          projectionVersion: 1,
        },
      },
      appliers: {},
    };

    const lineA = canonicalizeJcs(['oracle_sort', 'A\u{10000}']);
    const lineB = canonicalizeJcs(['oracle_sort', 'A\uFF00']);
    const utf8Order = [lineA, lineB].sort(byUtf8);
    const utf16Order = [lineA, lineB].sort(); // JS default
    // The two orders genuinely differ for this data (else the test proves nothing).
    expect(utf8Order).not.toEqual(utf16Order);

    const digest = await digestModule(harness.db, manifest, { hash: sha256 });
    expect(digest).toBe(sha256Hex(`${utf8Order.join('\n')}\n`));
    expect(digest).not.toBe(sha256Hex(`${utf16Order.join('\n')}\n`));
  });
});

describe('assertManifestColumnsComplete — the coverage denominator (T-14)', () => {
  test('passes when the manifest declares exactly the physical columns', async () => {
    await expect(
      assertManifestColumnsComplete(harness.db, 'notes', notesTable),
    ).resolves.toBeUndefined();
  });

  test('an undeclared physical column is a review failure (04 §4.4)', async () => {
    // Drop one declared column from a copy of the notes manifest: the physical table now has a
    // column the manifest does not declare, which the oracle would silently skip.
    const rest = Object.fromEntries(
      Object.entries(notesTable.columns).filter(([name]) => name !== 'last_edited_at'),
    ) as typeof notesTable.columns;
    const underdeclared = { ...notesTable, columns: rest };
    await expect(assertManifestColumnsComplete(harness.db, 'notes', underdeclared)).rejects.toThrow(
      OracleError,
    );
  });

  test('the real notes manifest matches its physical table after ops apply', async () => {
    await deliverPulled(harness, generateNotesScript(5, { deviceCount: 2, opsPerDevice: 10 }));
    for (const [name, table] of Object.entries(notesModule.tables)) {
      await expect(assertManifestColumnsComplete(harness.db, name, table)).resolves.toBeUndefined();
    }
  });
});

function byUtf8(a: string, b: string): number {
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

function sha256Hex(text: string): string {
  const bytes = sha256(utf8ToBytes(text));
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}
