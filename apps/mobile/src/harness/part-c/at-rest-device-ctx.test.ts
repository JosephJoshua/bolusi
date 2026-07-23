// SEC-DEV-06 at-rest device-ctx ORCHESTRATION (task 27a; testing-guide T-14b). The probe logic and
// its positive control are unit-proven in @bolusi/test-support; what THIS test binds is the ctx that
// wires them in the right ORDER — the CRUX: the positive control runs FIRST, and a vacuous seed
// short-circuits to a red gate WITHOUT ever trusting the ciphertext result. On the emulator the seams
// are the real app-layer column cipher / a real cipher-disabled control DB (NOT SQLCipher — D22
// removed it, task 148); here they are fakes, which is enough to prove the ordering because the
// ordering is all that this file decides.
import { describe, expect, test } from 'vitest';

import {
  AT_REST_ENCRYPTED_COLUMNS,
  type AtRestProbeContext,
  type SealedCell,
} from '@bolusi/test-support';

import { AT_REST_GATE_ID, runAtRestGate, type AtRestDeviceEnv } from './at-rest-device-ctx.js';

const MARKERS = ['Twelve crates of stock', 'faktur-0093'];

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Control bytes that DO carry every marker — a witnessed seed. */
function controlWithMarkers(): Uint8Array {
  const parts = MARKERS.map((m) => encode(m));
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length + 1;
  }
  return bytes;
}

const SEALED_PREFIX = `${String.fromCharCode(1)}gcm1:AAAAAAAAAAAA:`;

/** Every signed-off column, observed and sealed — a healthy post-D22 device. */
function sealedCells(): SealedCell[] {
  return AT_REST_ENCRYPTED_COLUMNS.map(([table, column]) => ({
    table,
    column,
    value: `${SEALED_PREFIX}c2VhbGVk`,
  }));
}

/**
 * A HEALTHY probe ctx. Note what it now looks like: the file bytes START with the plain-SQLite magic,
 * because post-D22 that is correct — the FILE is plain SQLite and only the COLUMNS are sealed. The
 * previous version of this fake asserted the opposite and kept this suite green while the real gate
 * would have gone red on healthy hardware.
 */
function ciphertextCtx(): AtRestProbeContext {
  return {
    readCopyBytes: () => Promise.resolve(encode('SQLite format 3\u0000blobs')),
    plaintextMarkers: MARKERS,
    readSealedCells: () => Promise.resolve(sealedCells()),
    sealedPrefix: SEALED_PREFIX,
  };
}

/** A LEAKY probe ctx: a seeded marker survives in the bytes and one column is stored unsealed. */
function plaintextCtx(): AtRestProbeContext {
  const cells = sealedCells();
  cells[4] = { table: 'notes', column: 'body', value: MARKERS[0] ?? '' };
  return {
    readCopyBytes: () =>
      Promise.resolve(new Uint8Array([...encode('SQLite format 3'), ...encode(MARKERS[0] ?? '')])),
    plaintextMarkers: MARKERS,
    readSealedCells: () => Promise.resolve(cells),
    sealedPrefix: SEALED_PREFIX,
  };
}

describe('runAtRestGate — positive control before ciphertext trust (CRUX, T-14b)', () => {
  test('PASS: control witnessed AND every protected column is sealed', async () => {
    const env: AtRestDeviceEnv = {
      plaintextMarkers: MARKERS,
      seedUnencryptedControl: () => Promise.resolve(controlWithMarkers()),
      seedEncryptedDb: () => Promise.resolve(ciphertextCtx()),
    };
    const gate = await runAtRestGate(env);
    expect(gate.id).toBe(AT_REST_GATE_ID);
    expect(gate.status).toBe('pass');
  });

  test('CRUX: a vacuous seed (control missing markers) FAILS the gate and NEVER trusts the ciphertext', async () => {
    let encryptedProbed = false;
    const env: AtRestDeviceEnv = {
      plaintextMarkers: MARKERS,
      // The seed is a silent no-op — the control DB does NOT carry the markers.
      seedUnencryptedControl: () => Promise.resolve(new Uint8Array([0x00, 0x01, 0x02])),
      seedEncryptedDb: () => {
        encryptedProbed = true;
        // Even if the ciphertext check WOULD pass, the gate must not reach or trust it.
        return Promise.resolve(ciphertextCtx());
      },
    };
    const gate = await runAtRestGate(env);
    expect(gate.status).toBe('fail');
    expect(gate.detail).toContain('positive control');
    // Short-circuited: the ciphertext leg was never even seeded.
    expect(encryptedProbed).toBe(false);
  });

  test('FAIL: control witnessed but a protected column is stored unsealed', async () => {
    const env: AtRestDeviceEnv = {
      plaintextMarkers: MARKERS,
      seedUnencryptedControl: () => Promise.resolve(controlWithMarkers()),
      seedEncryptedDb: () => Promise.resolve(plaintextCtx()),
    };
    const gate = await runAtRestGate(env);
    expect(gate.status).toBe('fail');
    expect(gate.detail.toLowerCase()).toContain('not ciphertext');
  });
});
