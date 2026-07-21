// SEC-DEV-06 at-rest device-ctx ORCHESTRATION (task 27a; testing-guide T-14b). The probe logic and
// its positive control are unit-proven in @bolusi/test-support; what THIS test binds is the ctx that
// wires them in the right ORDER — the CRUX: the positive control runs FIRST, and a vacuous seed
// short-circuits to a red gate WITHOUT ever trusting the ciphertext result. On the emulator the seams
// are real SQLCipher / a real unencrypted control DB; here they are fakes, which is enough to prove
// the ordering because the ordering is all that this file decides.
import { describe, expect, test } from 'vitest';

import type { DbDriver } from '@bolusi/db-client';
import type { AtRestProbeContext } from '@bolusi/test-support';

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

/** A full DbDriver fake (typed on purpose — a partial cast would hide a probe reaching a new method). */
function driver(overrides: Partial<DbDriver> = {}): DbDriver {
  return {
    execute: () => Promise.resolve({ rows: [{ c: 7 }], rowsAffected: 0, insertId: null }),
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

/** A ciphertext probe ctx: every open is refused, bytes carry no plaintext. */
function ciphertextCtx(): AtRestProbeContext {
  return {
    openCopy: () => Promise.reject(new Error('file is not a database')),
    readCopyBytes: () => Promise.resolve(new Uint8Array([0x9a, 0x41, 0x00, 0xd3])),
    wrongKey: 'ff'.repeat(32),
    plaintextMarkers: MARKERS,
  };
}

/** A LEAKY probe ctx: the DB opens unkeyed and the bytes carry a marker — not ciphertext. */
function plaintextCtx(): AtRestProbeContext {
  return {
    openCopy: () => Promise.resolve(driver()),
    readCopyBytes: () =>
      Promise.resolve(new Uint8Array([...encode('SQLite format 3'), ...encode(MARKERS[0] ?? '')])),
    wrongKey: 'ff'.repeat(32),
    plaintextMarkers: MARKERS,
  };
}

describe('runAtRestGate — positive control before ciphertext trust (CRUX, T-14b)', () => {
  test('PASS: control witnessed AND the SQLCipher file is ciphertext', async () => {
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

  test('FAIL: control witnessed but the SQLCipher file leaks plaintext', async () => {
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
