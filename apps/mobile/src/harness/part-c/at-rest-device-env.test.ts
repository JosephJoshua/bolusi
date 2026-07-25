// Host proof of the at-rest device ENV (task 178) — as far as op-sqlite allows off the emulator.
//
// The DETECTION logic (`checkDbAtRestIsCiphertext` + its T-14b control) is already Node-falsified in
// `@bolusi/test-support` and `at-rest-device-ctx.test.ts`. What is NEW in task 178 is the SEED: driving
// the 11 real production writers so a real DB carries a non-null SEALED cell in every signed-off column.
// This suite binds the env's platform seams to better-sqlite3 + `nodeColumnAead` + node:fs (op-sqlite is
// a JSI module that cannot load under Node — testing-guide §2.3), which lets vitest prove:
//   1. a full seed makes the at-rest gate PASS (all 11 columns observed + sealed, control witnessed);
//   2. SKIPPING one column reds the COVERAGE check, NAMING the missing column (the seed falsification
//      the task calls for — a partial seed is a RED, not a vacuous pass);
//   3. SEC-AUTH-09 leg 1 (the verifier-scoped gate) goes green on a full seed and RED when the verifier
//      seed is skipped.
// The real op-sqlite bytes are the only emulator-only residual; the parent dispatches that run.
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { closeClientDb, type DbDriver, type DbDriverOpenParams } from '@bolusi/db-client';
import { AT_REST_ENCRYPTED_COLUMNS, nodeColumnAead } from '@bolusi/test-support';

import { openBetterSqlite3Driver } from '../../../test/better-sqlite3-driver.js';
import { runAtRestGate, runVerifierAtRestGate } from './at-rest-device-ctx.js';
import { createAtRestDeviceEnv, type AtRestDeviceSeams } from './at-rest-device-env.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bolusi-atrest-env-'));
});

afterEach(async () => {
  // The connection is a module singleton; a mid-seed throw could leave it open for the next test.
  await closeClientDb().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The env seams bound to Node: better-sqlite3 for the driver (location = the full file path per name),
 * `nodeColumnAead` for the production cipher, and node:fs for the physical byte reads/copies — the same
 * roles op-sqlite + expo-file-system + deviceColumnAead fill on device.
 */
function hostSeams(): AtRestDeviceSeams {
  return {
    aead: nodeColumnAead,
    driverFactory: (params: DbDriverOpenParams): Promise<DbDriver> =>
      openBetterSqlite3Driver({ name: params.name, location: join(dir, params.name) }),
    location: dir,
    readBytesOf: (name) => Promise.resolve(new Uint8Array(readFileSync(join(dir, name)))),
    copyDbFile: (src, dst) => {
      copyFileSync(join(dir, src), join(dir, dst));
      return Promise.resolve();
    },
    removeDb: (name) => {
      for (const suffix of ['', '-wal', '-shm']) rmSync(join(dir, name + suffix), { force: true });
      return Promise.resolve();
    },
  };
}

/** Every signed-off column except one, as a seed-subset — the falsification lever. */
function allBut(table: string, column: string): readonly (readonly [string, string])[] {
  return AT_REST_ENCRYPTED_COLUMNS.filter(([t, c]) => !(t === table && c === column));
}

// NOTE ON TITLES (security-guide §2.1.6): these are the NODE leg (better-sqlite3), NOT the
// device-verified at-rest claim — the real op-sqlite bytes are the emulator's. So the SEC ids are
// deliberately kept OUT of these titles; a green here must never read as the shipped device claim
// (the same discipline packages/harness/test/at-rest-column-encryption.test.ts follows).
describe('createAtRestDeviceEnv — the real 11-column at-rest seed (task 178; Node leg)', () => {
  test('a full seed of all 11 columns makes the at-rest gate PASS', async () => {
    const env = createAtRestDeviceEnv(hostSeams());
    const gate = await runAtRestGate(env);
    expect(gate.status, gate.detail).toBe('pass');
    expect(gate.detail.toLowerCase()).toContain('ciphertext');
  });

  test('FALSIFICATION: skipping media_items.location reds COVERAGE, naming the missing column', async () => {
    const env = createAtRestDeviceEnv(hostSeams(), allBut('media_items', 'location'));
    const gate = await runAtRestGate(env);
    expect(gate.status).toBe('fail');
    expect(gate.detail).toContain('media_items.location');
    // The reason is coverage — the column produced no cell — not a control/plaintext complaint.
    expect(gate.detail.toLowerCase()).toContain('no non-null cell');
  });

  test('FALSIFICATION: skipping users_directory.name reds COVERAGE, naming it (a second column)', async () => {
    const env = createAtRestDeviceEnv(hostSeams(), allBut('users_directory', 'name'));
    const gate = await runAtRestGate(env);
    expect(gate.status).toBe('fail');
    expect(gate.detail).toContain('users_directory.name');
  });
});

describe('runVerifierAtRestGate — the PIN-verifier at-rest leg (task 178; Node leg)', () => {
  test('a full seed makes the verifier gate PASS (salt/hash/params all sealed)', async () => {
    const env = createAtRestDeviceEnv(hostSeams());
    const gate = await runVerifierAtRestGate(env);
    expect(gate.id).toBe('SEC-AUTH-09-leg1');
    expect(gate.status, gate.detail).toBe('pass');
  });

  test('FALSIFICATION: skipping the verifier seed reds the gate, naming user_pin_verifiers', async () => {
    const noVerifier = AT_REST_ENCRYPTED_COLUMNS.filter(([t]) => t !== 'user_pin_verifiers');
    const env = createAtRestDeviceEnv(hostSeams(), noVerifier);
    const gate = await runVerifierAtRestGate(env);
    expect(gate.status).toBe('fail');
    expect(gate.detail).toContain('user_pin_verifiers');
  });
});
