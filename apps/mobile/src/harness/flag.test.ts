// The harness is UNREACHABLE unless BOLUSI_TEST_HARNESS=1 (testing-guide §2.6). This falsifies the
// runtime half of that gate: with the flag unset, `loadHarness()` hands back nothing, so production
// wiring that imports the module still cannot reach a runner; with it set, the runners appear. The
// build-time half (the flag lives ONLY in the `test` EAS profile) is test/harness-flag.test.ts.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { HARNESS_RESULT_TAG, harnessEnabled } from './flag.js';
import { loadHarness } from './registry.js';
import { SEED_200K } from '@bolusi/test-support';

const KEY = 'BOLUSI_TEST_HARNESS';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[KEY];
  delete process.env[KEY];
});
afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

describe('harness flag gate (testing-guide §2.6)', () => {
  test('the tag is the §2.6 wire contract literal', () => {
    expect(HARNESS_RESULT_TAG).toBe('BOLUSI_HARNESS_RESULT');
  });

  test('harnessEnabled is false unless the flag is exactly "1"', () => {
    expect(harnessEnabled()).toBe(false);
    process.env[KEY] = '0';
    expect(harnessEnabled()).toBe(false);
    process.env[KEY] = 'true';
    expect(harnessEnabled()).toBe(false);
    process.env[KEY] = '1';
    expect(harnessEnabled()).toBe(true);
  });

  test('loadHarness returns null when the flag is unset — the harness is unreachable', () => {
    expect(loadHarness()).toBeNull();
  });

  test('loadHarness returns the runners only when the flag is set', () => {
    process.env[KEY] = '1';
    const harness = loadHarness();
    expect(harness).not.toBeNull();
    expect(typeof harness?.runAtRest).toBe('function');
    // The SEED-200K builder is wired and produces the pinned composition.
    expect(harness?.seedSpec).toBe(SEED_200K);
    expect(harness?.buildSeed()).toHaveLength(SEED_200K.totalOps);
    expect(harness?.requiredGateIds).toContain('SEC-DEV-06-at-rest');
  });
});
