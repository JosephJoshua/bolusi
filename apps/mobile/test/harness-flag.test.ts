// The BUILD-time half of the harness flag gate (testing-guide §2.6, 08 §5.5). `BOLUSI_TEST_HARNESS`
// must exist in the `test` EAS profile ONLY — never in production or preview, or the harness stack
// (which its runtime `harnessEnabled()` gate keys on) could compile into a shipped build. This reads
// the REAL eas.json and asserts exactly that placement, so moving the flag into another profile reds
// this lane rather than quietly widening the harness's reach.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const eas = JSON.parse(readFileSync(join(HERE, '..', 'eas.json'), 'utf8')) as {
  build: Record<string, { env?: Record<string, string> }>;
};

const FLAG = 'BOLUSI_TEST_HARNESS';

describe('eas.json harness-flag placement (08 §5.5)', () => {
  test('the flag is set to "1" in the test profile', () => {
    expect(eas.build.test?.env?.[FLAG]).toBe('1');
  });

  test('the flag appears in NO other profile — never production or preview', () => {
    for (const [name, profile] of Object.entries(eas.build)) {
      if (name === 'test') continue;
      expect(profile.env?.[FLAG]).toBeUndefined();
    }
    // Explicitly name the profiles that must stay clean, so a renamed/added profile is covered too.
    expect(eas.build.production?.env?.[FLAG]).toBeUndefined();
    expect(eas.build.preview?.env?.[FLAG]).toBeUndefined();
    expect(eas.build.development?.env?.[FLAG]).toBeUndefined();
  });
});
