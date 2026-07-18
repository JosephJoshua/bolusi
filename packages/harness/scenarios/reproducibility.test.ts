// Reproduction-command faithfulness (testing-guide §3.7). A nightly failure is only actionable if
// its printed command reproduces THE SAME concrete run. The bug this guards: `CHAOS_SCALE` does not
// merely scale volume — it changes the op sequence the seed PRNG draws — so a command that omits it
// reproduces a DIFFERENT scenario (green), and the real red is dismissed as flake.
//
// Falsification (§2.11): the assertions below go RED if the reproduction command drops the scale
// (the exact bug), and the scale-sensitivity test proves the concrete run really does depend on the
// scale — so "carry the scale" is load-bearing, not cosmetic. NOT named `chaos-NN-*` so the catalog
// meta-test does not read it as a scenario.
import { describe, expect, test } from 'vitest';

import { nightlySeeds, reproductionCommand } from '../src/reporter.js';
import { activeVolumes } from '../src/volumes.js';
import { runConvergence } from '../src/convergence.js';
import { withSeed } from '../src/index.js';

describe('nightly reproduction command is faithful (§3.7)', () => {
  test('the printed command carries the scale the run actually used (never a hardcoded 4)', () => {
    // The reviewer's verified case: nightly runSeed=1 → first seed 2693262066 at scale 4.
    expect(nightlySeeds(1)[0]).toBe(2693262066);
    expect(reproductionCommand(2693262066, { CHAOS_SCALE: '4' })).toBe(
      'CHAOS_SEEDS=2693262066 CHAOS_SCALE=4 pnpm chaos',
    );
    // A CI-scale failure prints scale 1 — the command mirrors the run, it does not assume nightly.
    expect(reproductionCommand(5, {})).toBe('CHAOS_SEEDS=5 CHAOS_SCALE=1 pnpm chaos');
    expect(reproductionCommand(5, { CHAOS_SCALE: '2' })).toBe(
      'CHAOS_SEEDS=5 CHAOS_SCALE=2 pnpm chaos',
    );
  });

  test('THE BUG: `pnpm chaos` without CHAOS_SCALE resolves to a DIFFERENT op count than the nightly', () => {
    // This is why the seed alone is not enough: scale 1 and scale 4 are different concrete runs.
    expect(activeVolumes({}).outOfOrderOpsPerDevice).toBe(500);
    expect(activeVolumes({ CHAOS_SCALE: '4' }).outOfOrderOpsPerDevice).toBe(2000);
  });

  test('the concrete run is a function of the scale-driven params — same params reproduce, different scale diverges', async () => {
    const seed = 909;
    // Small op counts stand in for the 500/2000 the scale drives — the POINT is that the run
    // depends on the op count (which CHAOS_SCALE sets), so the command must carry it.
    const paramsScale1 = {
      opsPerDevice: 15,
      deviceCount: 3,
      sharedNotes: 5,
      delivery: 'shuffled',
    } as const;
    const paramsScale2 = {
      opsPerDevice: 30,
      deviceCount: 3,
      sharedNotes: 10,
      delivery: 'shuffled',
    } as const;

    const a = await runConvergence(seed, paramsScale1);
    const aAgain = await runConvergence(seed, paramsScale1);
    const b = await runConvergence(seed, paramsScale2);
    try {
      // Same (seed, params) → byte-identical concrete run: the reproduction is faithful.
      expect(aAgain.reference.digest).toBe(a.reference.digest);
      expect(aAgain.reference.rows).toEqual(a.reference.rows);
      // Different scale-driven params → a DIFFERENT concrete run: dropping the scale would
      // reproduce THIS instead of the failing run (the bug).
      expect(b.reference.digest).not.toBe(a.reference.digest);
    } finally {
      await a.close();
      await aAgain.close();
      await b.close();
    }
  });

  test('withSeed embeds the verbatim reproduction command (seed + scale) in a failure', async () => {
    let message = '';
    try {
      await withSeed(
        7,
        () => {
          throw new Error('boom');
        },
        'CHAOS-XX',
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('CHAOS_SEEDS=7 CHAOS_SCALE=1 pnpm chaos');
    expect(message).toContain('boom');
  });
});
