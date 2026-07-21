// The nightly ×4 per-scenario SEED CAP, asserted (task 113 / testing-guide §3.7 D-CHAOS-SCALE).
//
// A cap that is not asserted is a silent coverage cut — the thing §2.11 and the whole D-CHAOS-SCALE
// policy exist to forbid. So this file pins all four things a reader of "nightly = 100 seeds × ×4"
// would otherwise have to take on faith:
//
//   1. The heavy scenarios' ×4 lane resolves to the CAPPED sample, and the uncapped DENOMINATOR it
//      is capped from is the full 100 (T-14 — a "cap" asserted against an already-empty list would
//      pass while proving nothing).
//   2. The LIGHT scenarios' ×4 lane still resolves to the full 100 — the cap is a two-row exception,
//      not a general trim.
//   3. The two heavy scenario files actually CALL the cap, and no other scenario file does (T-16 —
//      a mention is not a producer; the registry being right proves nothing if nothing reads it).
//   4. The number is the SAME in all three places that state it (registry, the nightly workflow's
//      stated coverage, testing-guide §3.7) and the nightly job really is a ×4 nightly lane, so the
//      cap predicate matches the job that runs it.
//
// The CI lane is asserted unchanged here too: off the ×4 nightly lane the cap is a pass-through.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  CI_SEEDS,
  NIGHTLY_SEED_COUNT,
  NIGHTLY_X4_SEED_CAPS,
  X4_SEED_CAP_ENV,
  isNightlyX4Lane,
  nightlyX4Seeds,
  resolveSeeds,
  x4SeedCap,
  type X4CappedScenario,
} from '../src/index.js';

const SCENARIOS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCENARIOS_DIR, '..', '..', '..');

/** The env the nightly job runs under: `CHAOS_NIGHTLY=1 CHAOS_SCALE=4` (asserted below). */
const NIGHTLY_X4: NodeJS.ProcessEnv = { CHAOS_NIGHTLY: '1', CHAOS_SCALE: '4' };
/** The CI merge gate's env: no chaos vars at all. */
const CI: NodeJS.ProcessEnv = {};

const CAPPED_IDS = Object.keys(NIGHTLY_X4_SEED_CAPS) as X4CappedScenario[];

function scenarioFiles(): { file: string; id: string; text: string }[] {
  return readdirSync(SCENARIOS_DIR)
    .filter((f) => /^chaos-\d{2}-.*\.test\.ts$/.test(f))
    .sort()
    .map((file) => ({
      file,
      id: `CHAOS-${/^chaos-(\d{2})-/.exec(file)![1]}`,
      text: readFileSync(join(SCENARIOS_DIR, file), 'utf8'),
    }));
}

describe('nightly ×4 per-scenario seed cap (§3.7 D-CHAOS-SCALE)', () => {
  test('the registry is a small, sane, non-empty exception list', () => {
    // Denominator (T-14): an empty registry would make every "capped" assertion below vacuous.
    expect(CAPPED_IDS.length).toBeGreaterThanOrEqual(1);
    for (const id of CAPPED_IDS) {
      const cap = NIGHTLY_X4_SEED_CAPS[id];
      // A SMALL documented sample — task 113 fixes the band at 3–5. Zero would run nothing; a large
      // sample would not solve the unrunnability the cap exists for.
      expect(cap, `${id} cap`).toBeGreaterThanOrEqual(3);
      expect(cap, `${id} cap`).toBeLessThanOrEqual(5);
    }
  });

  test('heavy scenarios: the ×4 lane resolves to the capped sample, out of the FULL 100', () => {
    const denominator = resolveSeeds(NIGHTLY_X4);
    // The thing being capped really is the full nightly set — otherwise "capped to 3" could be a
    // no-op on a list that was already 3 long, and this whole file would be theatre (T-14).
    expect(denominator).toHaveLength(NIGHTLY_SEED_COUNT);
    expect(NIGHTLY_SEED_COUNT).toBe(100);

    for (const id of CAPPED_IDS) {
      const sampled = nightlyX4Seeds(id, denominator, NIGHTLY_X4);
      expect(sampled, `${id} ×4 sample size`).toHaveLength(NIGHTLY_X4_SEED_CAPS[id]);
      expect(sampled.length, `${id} must be a REDUCTION`).toBeLessThan(denominator.length);
      // Deterministic prefix of the same derived list — a failing sampled seed reproduces verbatim.
      expect(sampled).toEqual(denominator.slice(0, NIGHTLY_X4_SEED_CAPS[id]));
    }
  });

  test('light scenarios: the ×4 lane still resolves to the full nightly seed set', () => {
    const light = scenarioFiles().filter((s) => !CAPPED_IDS.includes(s.id as X4CappedScenario));
    // Denominator: there ARE light scenarios (10 of the 12) — the claim is not vacuous.
    expect(light.length).toBeGreaterThanOrEqual(1);
    // They all resolve through the uncapped `resolveSeeds`, which returns 100 under the nightly env.
    expect(resolveSeeds(NIGHTLY_X4)).toHaveLength(NIGHTLY_SEED_COUNT);
  });

  test('the cap is WIRED: exactly the heavy scenario files call it (a mention is not a producer)', () => {
    const files = scenarioFiles();
    expect(files.length).toBeGreaterThanOrEqual(1);
    const seen = new Set<string>();
    for (const { file, id, text } of files) {
      // A CALL with this scenario's own id — not a comment mentioning the helper (T-16).
      const calls = new RegExp(`nightlyX4Seeds\\(\\s*['"\`]${id}['"\`]`).test(text);
      const mentionsAnyCall = /nightlyX4Seeds\(/.test(text);
      if (CAPPED_IDS.includes(id as X4CappedScenario)) {
        expect(calls, `${file} is ×4-seed-capped but never calls nightlyX4Seeds('${id}')`).toBe(
          true,
        );
        seen.add(id);
      } else {
        expect(mentionsAnyCall, `${file} is not in the cap registry but calls nightlyX4Seeds`).toBe(
          false,
        );
      }
    }
    // Every registry row was matched to a real scenario file — a row naming a scenario that does not
    // exist would otherwise sit here forever looking like coverage.
    expect([...seen].sort()).toEqual([...CAPPED_IDS].sort());
  });

  test('the CI merge gate is UNCHANGED: off the ×4 nightly lane the cap is a pass-through', () => {
    expect(isNightlyX4Lane(CI)).toBe(false);
    for (const id of CAPPED_IDS) {
      expect(nightlyX4Seeds(id, resolveSeeds(CI), CI)).toEqual([...CI_SEEDS]);
    }
    // A ×1 nightly and an explicit reproduction are both uncapped (guardrail #2 of §3.7): the
    // printed `CHAOS_SEEDS=… CHAOS_SCALE=…` command must run exactly what it says.
    expect(isNightlyX4Lane({ CHAOS_NIGHTLY: '1' })).toBe(false);
    const repro = { CHAOS_NIGHTLY: '1', CHAOS_SCALE: '4', CHAOS_SEEDS: '7,9,11,13,15,17' };
    expect(isNightlyX4Lane(repro)).toBe(false);
    expect(nightlyX4Seeds('CHAOS-03', resolveSeeds(repro), repro)).toEqual([7, 9, 11, 13, 15, 17]);
  });

  test('a config that resolves ZERO seeds FAILS instead of passing vacuously (T-14)', () => {
    expect(() => nightlyX4Seeds('CHAOS-03', [], NIGHTLY_X4)).toThrow(/ZERO seeds/);
    expect(() => nightlyX4Seeds('CHAOS-08', [], CI)).toThrow(/ZERO seeds/);
    // And the override can never be talked down to a run-nothing cap.
    for (const bad of ['0', '-1', 'all', '']) {
      const env = { ...NIGHTLY_X4, [X4_SEED_CAP_ENV]: bad };
      if (bad === '') {
        // Empty == unset: fall back to the registry, never to "no seeds".
        expect(x4SeedCap('CHAOS-03', env)).toBe(NIGHTLY_X4_SEED_CAPS['CHAOS-03']);
      } else {
        expect(() => x4SeedCap('CHAOS-03', env), `${X4_SEED_CAP_ENV}=${bad}`).toThrow(/integer/);
      }
    }
    // A deliberate deeper sample is allowed and takes effect.
    const deeper = { ...NIGHTLY_X4, [X4_SEED_CAP_ENV]: '12' };
    expect(nightlyX4Seeds('CHAOS-03', resolveSeeds(deeper), deeper)).toHaveLength(12);
  });

  test('the nightly job really is a ×4 nightly lane, and states the caps it runs', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const nightly = pkg.scripts['chaos:nightly'];
    // If the job stopped setting either var, `isNightlyX4Lane` would silently stop matching and the
    // heavy scenarios would go back to 100 unrunnable ×4 seeds. Pin the job to the predicate.
    expect(nightly, 'chaos:nightly script').toBeDefined();
    expect(nightly).toContain('CHAOS_NIGHTLY=1');
    expect(nightly).toContain('CHAOS_SCALE=4');
    expect(isNightlyX4Lane({ CHAOS_NIGHTLY: '1', CHAOS_SCALE: '4' })).toBe(true);

    // The coverage claim must match reality in BOTH documents that make it.
    const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/chaos-nightly.yml'), 'utf8');
    const guide = readFileSync(join(REPO_ROOT, 'ai-docs/testing-guide.md'), 'utf8');
    for (const id of CAPPED_IDS) {
      const stated = new RegExp(`${id}\\s*→\\s*${NIGHTLY_X4_SEED_CAPS[id]} seeds`);
      expect(stated.test(workflow), `chaos-nightly.yml does not state ${id} → its cap`).toBe(true);
      expect(stated.test(guide), `testing-guide §3.7 does not state ${id} → its cap`).toBe(true);
    }
  });
});
