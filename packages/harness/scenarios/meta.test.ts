// Harness meta-tests (testing-guide §3 acceptance): determinism (T-6) and catalog integrity
// (SEC-META-01 style). These guard the harness ITSELF — a chaos suite that is non-deterministic,
// silently skipped, or auto-retried is worthless (T-10), so those failure modes are asserted here.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { CI_SEEDS, nightlySeeds, runConvergence } from '../src/index.js';

const SCENARIOS_DIR = dirname(fileURLToPath(import.meta.url));

/** The scenarios present in this build — one file per catalog entry `chaos-NN-*.test.ts`. */
function scenarioFiles(): { file: string; id: string; text: string }[] {
  return readdirSync(SCENARIOS_DIR)
    .filter((f) => /^chaos-\d{2}-.*\.test\.ts$/.test(f))
    .sort()
    .map((file) => {
      const match = /^chaos-(\d{2})-/.exec(file);
      return {
        file,
        id: `CHAOS-${match![1]}`,
        text: readFileSync(join(SCENARIOS_DIR, file), 'utf8'),
      };
    });
}

describe('harness determinism (T-6)', () => {
  test('same scenario + same seed → byte-identical digests across two runs', async () => {
    const opts = {
      opsPerDevice: 40,
      deviceCount: 3,
      sharedNotes: 12,
      delivery: 'shuffled',
    } as const;
    const first = await runConvergence(7, opts);
    const second = await runConvergence(7, opts);
    try {
      // The reference and every replica reproduce bit-for-bit from the seed alone.
      expect(second.reference.digest).toBe(first.reference.digest);
      expect(second.replicas.map((r) => r.digest)).toEqual(first.replicas.map((r) => r.digest));
      // And a DIFFERENT seed produces a DIFFERENT world (the fixture is not seed-blind — a positive
      // control: if these matched, "deterministic" would just mean "constant").
      const other = await runConvergence(8, opts);
      try {
        expect(other.reference.digest).not.toBe(first.reference.digest);
      } finally {
        await other.close();
      }
    } finally {
      await first.close();
      await second.close();
    }
  });

  test('CI seeds are the fixed 1–10 set and the nightly derivation is reproducible', () => {
    expect([...CI_SEEDS]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // A nightly seed list is a pure function of its run seed (reproduce a failure from its printout).
    expect(nightlySeeds(42)).toEqual(nightlySeeds(42));
    expect(nightlySeeds(42)).toHaveLength(100);
    expect(nightlySeeds(42)).not.toEqual(nightlySeeds(43));
  });
});

describe('catalog integrity (SEC-META-01 style)', () => {
  test('every shipped scenario file embeds its CHAOS id in a test title', () => {
    const files = scenarioFiles();
    // Denominator: fail loudly rather than pass vacuously on an empty glob (§2.11 / T-14).
    expect(files.length).toBeGreaterThanOrEqual(1);
    for (const { file, id, text } of files) {
      // The id must appear inside a test/it title — a mention in a comment does not count (T-16),
      // so we require it after `test(`/`it(` with a quote.
      const titled = new RegExp(`(?:test|it)\\(\\s*[\`'\"][^\`'\"]*${id}`).test(text);
      expect(titled, `${file} has no test title embedding ${id}`).toBe(true);
    }
  });

  test('no scenario is .skip / .only, and no auto-retry is configured (T-10)', () => {
    const files = scenarioFiles();
    for (const { file, text } of files) {
      expect(/\.(skip|only)\(/.test(text), `${file} uses .skip/.only`).toBe(false);
      expect(/\bretry\b\s*:/.test(text), `${file} configures a retry`).toBe(false);
    }
  });
});
