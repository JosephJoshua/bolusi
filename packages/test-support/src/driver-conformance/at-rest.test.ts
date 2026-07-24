// Proves the SEC-DEV-06 probe's DETECTION LOGIC in CI, against fakes.
//
// ── WHY THIS FILE WAS REWRITTEN (the lesson, kept where the next editor will read it) ──────────
// The previous version fed fakes shaped to SQLCipher's whole-file model: "an unkeyed open is
// refused", "the file does not start with `SQLite format 3`". D22 (task 148) deleted SQLCipher, so
// the real device now does the OPPOSITE of what those fakes described — the file IS plain SQLite and
// DOES open with no key — and yet this suite stayed green, because a fake will happily keep
// describing a world that no longer exists. The probe's premise died and its guard could not see it.
// That is the failure §2.11 names, arriving through the fixtures rather than the assertions.
//
// So the fakes below are written against the POST-D22 model, and the coverage test exists to stop the
// probe from ever passing vacuously: CI cannot witness on-device encryption (that is task 27a), but it
// can and must prove this probe is not a rubber stamp.
import { describe, expect, test } from 'vitest';

import {
  AT_REST_ENCRYPTED_COLUMNS,
  checkControlSeedIsWitnessed,
  checkDbAtRestIsCiphertext,
  type AtRestProbeContext,
  type SealedCell,
} from './at-rest.js';

const SEALED_PREFIX = `${String.fromCharCode(1)}gcm1:AAAAAAAAAAAA:`;
const MARKER = 'Twelve crates of stock';

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A healthy device: plain-SQLite bytes (expected!) with NO seeded plaintext anywhere in them. */
function healthyBytes(): Uint8Array {
  return encode('SQLite format 3\0some ciphertext blobs and ids');
}

/** Every signed-off column, observed and sealed — what a passing device produces. */
function sealedCells(): SealedCell[] {
  return AT_REST_ENCRYPTED_COLUMNS.map(([table, column]) => ({
    table,
    column,
    value: `${SEALED_PREFIX}c2VhbGVkLWJsb2I=`,
  }));
}

function context(overrides: Partial<AtRestProbeContext> = {}): AtRestProbeContext {
  return {
    readCopyBytes: () => Promise.resolve(healthyBytes()),
    plaintextMarkers: [MARKER],
    readSealedCells: () => Promise.resolve(sealedCells()),
    sealedPrefix: SEALED_PREFIX,
    ...overrides,
  };
}

describe('checkDbAtRestIsCiphertext (post-D22: sealed COLUMNS, plain-SQLite FILE)', () => {
  test('reports nothing when every column is sealed and no seeded plaintext survives', async () => {
    expect(await checkDbAtRestIsCiphertext(context())).toEqual([]);
  });

  test('a plain-SQLite file header is NOT a finding — it is the designed behaviour', async () => {
    // The single most important assertion in this file. Under SQLCipher this header meant "no
    // encryption"; post-D22 it is simply what the file looks like. Asserting it is absent would red
    // the first required emulator gate on a healthy device.
    const findings = await checkDbAtRestIsCiphertext(
      context({ readCopyBytes: () => Promise.resolve(encode('SQLite format 3\0')) }),
    );
    expect(findings.map((f) => f.check)).not.toContain('no plaintext SQLite header');
  });

  test('catches a seeded plaintext marker surviving in the file bytes', async () => {
    const bytes = new Uint8Array([0x00, 0x01, ...encode(MARKER), 0x02]);
    const findings = await checkDbAtRestIsCiphertext(
      context({ readCopyBytes: () => Promise.resolve(bytes) }),
    );
    expect(findings.map((f) => f.check)).toEqual(['no seeded plaintext markers']);
  });

  test('catches ONE unsealed column among the sealed ones', async () => {
    const cells = sealedCells();
    cells[4] = { table: 'notes', column: 'body', value: 'dua belas krat — in the clear' };
    const findings = await checkDbAtRestIsCiphertext(
      context({ readSealedCells: () => Promise.resolve(cells) }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.check).toBe('encrypted column is sealed');
    expect(findings[0]?.detail).toContain('notes.body');
  });

  test('a NULL cell is not a finding — nullable columns are legitimately null', async () => {
    const cells = sealedCells();
    cells[2] = { table: 'operations', column: 'location', value: null };
    const findings = await checkDbAtRestIsCiphertext(
      context({ readSealedCells: () => Promise.resolve(cells) }),
    );
    // …but it DOES cost coverage for that column, which is the honest outcome: a null proves nothing.
    expect(findings.map((f) => f.check)).toEqual(['every encrypted column was actually probed']);
    expect(findings[0]?.detail).toContain('operations.location');
  });

  test('COVERAGE: a device that seeded nothing FAILS instead of passing vacuously', async () => {
    // The anti-rubber-stamp assertion. With no cells and no surviving plaintext, checks (1) and (2)
    // are both trivially satisfied — exactly the empty-fixture shape that has produced eight
    // green-for-the-wrong-reason gates in this repo. Coverage is what makes the green mean something.
    const findings = await checkDbAtRestIsCiphertext(
      context({ readSealedCells: () => Promise.resolve([]) }),
    );
    expect(findings).toHaveLength(AT_REST_ENCRYPTED_COLUMNS.length);
    for (const finding of findings) {
      expect(finding.check).toBe('every encrypted column was actually probed');
    }
  });

  test('the coverage set is exactly the 11 signed-off columns (D22 addendum 2)', () => {
    expect(AT_REST_ENCRYPTED_COLUMNS).toHaveLength(11);
    expect(AT_REST_ENCRYPTED_COLUMNS.map(([t, c]) => `${t}.${c}`)).toEqual([
      'operations.payload',
      'operations.signed_core_jcs',
      'operations.location',
      'notes.title',
      'notes.body',
      'user_pin_verifiers.salt',
      'user_pin_verifiers.hash',
      'user_pin_verifiers.params',
      'media_items.location',
      'quarantined_ops.signed_core_jcs',
      'users_directory.name',
    ]);
  });
});

// The POSITIVE CONTROL for the on-device leg (testing-guide T-14b) — UNCHANGED by D22, because it
// binds the SEED, not the cipher. The marker checks pass when the seeded values are ABSENT, which is
// ALSO what a silent seed no-op produces, so the device ctx must first witness the SAME markers in a
// cipher-disabled control DB before it may trust their absence in the real file.
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
