// Seed reporting (testing-guide T-6 / §3.7): "every randomized test prints its seed on failure and
// is reproducible from that seed alone." A chaos failure is a real bug (T-10 — no quarantine, no
// retry); the ONLY thing standing between a nightly red and a local reproduction is its printed
// REPRODUCTION COMMAND — and that command must carry the SCALE, not just the seed.
//
// WHY THE SCALE, NOT JUST THE SEED. `CHAOS_SCALE` is not a volume knob that shrinks a fixed run —
// it changes the concrete run. `runConvergence` draws every op from the seed PRNG in a
// `for k < opsPerDevice` loop and sizes the shared-note pool from `opsPerDevice`, so the SAME seed
// at scale 1 (500 ops) vs scale 4 (2,000 ops) produces an ENTIRELY DIFFERENT op sequence, not a
// prefix. So `CHAOS_SEEDS=<seed> pnpm chaos` (scale 1) does NOT reproduce a nightly failure that
// ran at scale 4 — it runs a different scenario, passes green, and the real red is dismissed as
// flake. The reproduction command therefore always names the scale it ran at.
import { mulberry32 } from '@bolusi/test-support';

import { activeVolumes } from './volumes.js';

/** Fixed CI seeds — every PR runs each scenario at these (testing-guide §3.3). */
export const CI_SEEDS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** How many PRNG-chosen seeds the nightly job runs per scenario (§3.3). */
export const NIGHTLY_SEED_COUNT = 100;

/**
 * Derive the nightly seed list deterministically from a top-level run seed. The derivation is
 * mulberry32 so the same run seed always produces the same 100 seeds.
 */
export function nightlySeeds(runSeed: number, count = NIGHTLY_SEED_COUNT): number[] {
  const prng = mulberry32(runSeed);
  const seeds: number[] = [];
  for (let i = 0; i < count; i += 1) {
    // A full uint32 so the nightly space is not a thin prefix of the CI space.
    seeds.push(Math.floor(prng() * 0xffff_ffff) >>> 0);
  }
  return seeds;
}

/**
 * The verbatim command that reproduces a run of `seed` at the CURRENTLY-ACTIVE scale. It reads the
 * scale from the SAME `activeVolumes(env)` the run used (never a hardcoded 4) — so a CI-scale
 * failure prints scale 1 and a nightly failure prints its ×4, and each command, run verbatim,
 * reproduces the concrete op sequence that failed.
 */
export function reproductionCommand(seed: number, env: NodeJS.ProcessEnv = process.env): string {
  return `CHAOS_SEEDS=${seed} CHAOS_SCALE=${activeVolumes(env).scale} pnpm chaos`;
}

/** Prefix a message with its reproducing seed. Exposed so assertions can build the same string. */
export function seedTag(seed: number, scenario?: string): string {
  return scenario === undefined ? `[seed=${seed}]` : `[${scenario} seed=${seed}]`;
}

/**
 * The seeds a scenario runs. Default = the fixed CI set (1–10). `CHAOS_NIGHTLY=1` switches to 100
 * PRNG-chosen seeds (logged with their scale, per §3.7). `CHAOS_SEEDS=3,7,42` overrides both — the
 * local one-liner that reproduces specific seeds (pair it with the same `CHAOS_SCALE` the failure ran
 * at, which the reproduction command prints).
 */
export function resolveSeeds(env: NodeJS.ProcessEnv = process.env): number[] {
  const explicit = env.CHAOS_SEEDS;
  if (explicit !== undefined && explicit !== '') {
    return explicit.split(',').map((s) => {
      const n = Number.parseInt(s.trim(), 10);
      if (!Number.isInteger(n)) throw new Error(`CHAOS_SEEDS entry is not an integer: ${s}`);
      return n;
    });
  }
  if (env.CHAOS_NIGHTLY === '1') {
    const runSeed = Number.parseInt(env.CHAOS_NIGHTLY_RUN_SEED ?? '1', 10);
    const seeds = nightlySeeds(runSeed);
    const scale = activeVolumes(env).scale;
    // Log the whole set AND the scale, so any nightly failure is reproducible verbatim: a failing
    // seed N reproduces with `CHAOS_SEEDS=N CHAOS_SCALE=<scale> pnpm chaos` (the same command
    // `reproductionCommand`/`withSeed` print on the failing test itself).

    console.log(`[chaos:nightly] runSeed=${runSeed} scale=${scale} seeds=${seeds.join(',')}`);

    console.log(
      `[chaos:nightly] reproduce a failing seed N: CHAOS_SEEDS=N CHAOS_SCALE=${scale} pnpm chaos`,
    );
    return seeds;
  }
  return [...CI_SEEDS];
}

/**
 * Run `body(seed)` and, on any throw, re-throw the SAME error prefixed with the verbatim
 * REPRODUCTION COMMAND (seed + the scale it ran at) so the failure output alone reproduces the run.
 * Returns the body's value on success.
 */
export async function withSeed<T>(
  seed: number,
  body: (seed: number) => Promise<T> | T,
  scenario?: string,
): Promise<T> {
  try {
    return await body(seed);
  } catch (error) {
    const label = scenario === undefined ? '' : `${scenario} `;
    const tag = `[${label}reproduce: ${reproductionCommand(seed)}]`;
    if (error instanceof Error) {
      error.message = `${tag} ${error.message}`;
      throw error;
    }
    throw new Error(`${tag} ${String(error)}`);
  }
}
