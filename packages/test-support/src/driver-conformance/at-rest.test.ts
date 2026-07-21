// Proves the SEC-DEV-06 probe's DETECTION LOGIC in CI, against fakes.
//
// CI has no SQLCipher (better-sqlite3 ships none), so CI cannot witness ciphertext at
// rest — that is task 27's on-device leg. What CI can and must prove is that the probe
// is not a rubber stamp: given a plaintext database it reports findings, and it only
// reports "clean" when all three checks genuinely hold. A probe that always returned []
// would pass a device run and prove nothing.
import { describe, expect, test } from 'vitest';
import type { DbDriver } from '@bolusi/db-client';

import {
  checkControlSeedIsWitnessed,
  checkDbAtRestIsCiphertext,
  type AtRestProbeContext,
} from './at-rest.js';

const WRONG_KEY = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
const MARKER = 'Twelve crates of stock';

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Bytes that look like real SQLCipher output: no header, no plaintext. */
function ciphertextBytes(): Uint8Array {
  return new Uint8Array([0x9a, 0x41, 0x00, 0xd3, 0x7f, 0xe2, 0x11, 0x08]);
}

/** Bytes of an UNENCRYPTED SQLite file. `\0` is the escape, not a literal NUL byte: the
 * real header is 16 bytes ending in NUL, but embedding one makes git treat this file as
 * binary — and this is the file that proves the SEC-DEV-06 probe isn't a rubber stamp, so
 * it has to stay readable in a diff. */
function plaintextBytes(): Uint8Array {
  const header = encode('SQLite format 3\0');
  const marker = encode(MARKER);
  const bytes = new Uint8Array(header.length + marker.length);
  bytes.set(header, 0);
  bytes.set(marker, header.length);
  return bytes;
}

function context(overrides: Partial<AtRestProbeContext> = {}): AtRestProbeContext {
  return {
    // Encrypted DB: every unkeyed/wrong-key open is refused.
    openCopy: () => Promise.reject(new Error('file is not a database')),
    readCopyBytes: () => Promise.resolve(ciphertextBytes()),
    wrongKey: WRONG_KEY,
    plaintextMarkers: [MARKER],
    ...overrides,
  };
}

/**
 * A COMPLETE `DbDriver` fake. Typed as `DbDriver` on purpose: a partial fake that only
 * happens to satisfy the methods the probe calls today would break confusingly the moment
 * the probe reaches for `begin()` or `prepare()`, and a cast would hide exactly that.
 */
function makeDriver(overrides: Partial<DbDriver> = {}): DbDriver {
  return {
    execute: () => Promise.resolve({ rows: [{ c: 19 }], rowsAffected: 0, insertId: null }),
    executeBatch: () => Promise.resolve({ rowsAffected: 0 }),
    prepare: () => ({
      execute: () => Promise.resolve({ rows: [], rowsAffected: 0, insertId: null }),
      finalize: () => Promise.resolve(),
    }),
    begin: () => Promise.resolve(),
    commit: () => Promise.resolve(),
    rollback: () => Promise.resolve(),
    close: () => Promise.resolve(),
    ...overrides,
  };
}

/** Opens AND reads — i.e. an unencrypted database, the failure the probe must catch. */
function readableDriver(): Promise<DbDriver> {
  return Promise.resolve(makeDriver());
}

describe('checkDbAtRestIsCiphertext', () => {
  test('reports nothing when the file is genuinely ciphertext', async () => {
    expect(await checkDbAtRestIsCiphertext(context())).toEqual([]);
  });

  test('catches a database that opens WITHOUT a key', async () => {
    const findings = await checkDbAtRestIsCiphertext(
      context({
        openCopy: (key) =>
          key === null ? readableDriver() : Promise.reject(new Error('file is not a database')),
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.check).toBe('open without key is refused');
  });

  test('catches a database that opens with the WRONG key', async () => {
    const findings = await checkDbAtRestIsCiphertext(
      context({
        openCopy: (key) =>
          key === WRONG_KEY
            ? readableDriver()
            : Promise.reject(new Error('file is not a database')),
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.check).toBe('open with wrong key is refused');
  });

  test('catches the plaintext SQLite header and the seeded marker in the file bytes', async () => {
    const findings = await checkDbAtRestIsCiphertext(
      context({ readCopyBytes: () => Promise.resolve(plaintextBytes()) }),
    );
    expect(findings.map((finding) => finding.check)).toEqual([
      'no plaintext SQLite header',
      'no seeded plaintext markers',
    ]);
  });

  test('reports every failure at once for a fully unencrypted database', async () => {
    const findings = await checkDbAtRestIsCiphertext(
      context({ openCopy: readableDriver, readCopyBytes: () => Promise.resolve(plaintextBytes()) }),
    );
    expect(findings.map((finding) => finding.check)).toEqual([
      'open without key is refused',
      'open with wrong key is refused',
      'no plaintext SQLite header',
      'no seeded plaintext markers',
    ]);
  });

  test('an open that succeeds but cannot READ counts as encrypted', async () => {
    // SQLCipher defers key verification to the first page read: open() alone succeeding
    // is not evidence of a decryptable database, so the probe must not treat it as one.
    // This is the case that makes `expectUnreadable` probe with a real query rather than
    // trusting open() — a full driver whose reads reject is exactly a keyed SQLCipher DB.
    const findings = await checkDbAtRestIsCiphertext(
      context({
        openCopy: () =>
          Promise.resolve(
            makeDriver({ execute: () => Promise.reject(new Error('file is not a database')) }),
          ),
      }),
    );
    expect(findings).toEqual([]);
  });

  test('a marker appearing only as a substring of the ciphertext is still caught', async () => {
    const bytes = new Uint8Array([0x00, 0x01, ...encode(MARKER), 0x02]);
    const findings = await checkDbAtRestIsCiphertext(
      context({ readCopyBytes: () => Promise.resolve(bytes) }),
    );
    expect(findings.map((finding) => finding.check)).toEqual(['no seeded plaintext markers']);
  });
});

// The POSITIVE CONTROL for the on-device leg (testing-guide T-14b). `checkDbAtRestIsCiphertext`'s
// last two checks pass when the seeded markers are ABSENT from the file — which is ALSO exactly what
// happens when the seed silently wrote nothing (the parse-collapse / empty-fixture family, and the
// RLS `UPDATE 0` incident in one shape over). So the device ctx (task 27a) must first witness the
// SAME markers in an UNENCRYPTED control DB before it may trust their absence in the SQLCipher file.
// This is the Node-runnable half of that control: given the control DB's raw bytes, a marker MISSING
// means the seed is a no-op, so the whole absence result is vacuous. CI has no live seed here, so
// this binds only the DETECTION direction; the device ctx (apps/mobile) wires it to a real control DB.
describe('checkControlSeedIsWitnessed — the T-14b positive control', () => {
  const MARKERS = ['Twelve crates of stock', 'faktur-0093'];

  test('an empty result when every seeded marker IS present in the control bytes', () => {
    const bytes = new Uint8Array([
      0x00,
      ...encode(MARKERS[0] ?? ''),
      0x7f,
      ...encode(MARKERS[1] ?? ''),
    ]);
    expect(checkControlSeedIsWitnessed(bytes, MARKERS)).toEqual([]);
  });

  test('catches a silent seed no-op: a marker missing from the control is a finding (result is vacuous)', () => {
    // The control DB carries only the FIRST marker — the seed of the second did nothing, so
    // "no plaintext in the ciphertext" would prove nothing for it.
    const bytes = new Uint8Array([...encode(MARKERS[0] ?? '')]);
    const findings = checkControlSeedIsWitnessed(bytes, MARKERS);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.check).toContain('positive control');
    expect(findings[0]?.detail).toContain(JSON.stringify(MARKERS[1]));
  });

  test('empty control bytes fail the control for EVERY marker — the seed wrote nothing at all', () => {
    const findings = checkControlSeedIsWitnessed(new Uint8Array(), MARKERS);
    expect(findings).toHaveLength(MARKERS.length);
  });
});
