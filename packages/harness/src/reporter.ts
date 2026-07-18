// Seed reporting (testing-guide T-6): "every randomized test prints its seed on failure and is
// reproducible from that seed alone." A chaos failure is a real bug (T-10 — no quarantine, no
// retry); the ONLY thing standing between a nightly red and a local reproduction is the seed, so a
// failure that does not carry its seed is a failure nobody can act on.
//
// `withSeed` wraps a seeded body so any throw is re-thrown with the seed prefixed to its message —
// the reporter unit test asserts a deliberately-failed run's error output contains the seed.
import { mulberry32 } from '@bolusi/test-support';

/** Fixed CI seeds — every PR runs each scenario at these (testing-guide §3.3). */
export const CI_SEEDS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** How many PRNG-chosen seeds the nightly job runs per scenario (§3.3). */
export const NIGHTLY_SEED_COUNT = 100;

/**
 * Derive the nightly seed list deterministically from a top-level run seed, and LOG each one — a
 * nightly failure is reproduced locally by lifting its printed seed into `CHAOS_SEEDS` (§3.7). The
 * derivation is mulberry32 so the same run seed always produces the same 100 seeds.
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

/** Prefix a message with its reproducing seed. Exposed so assertions can build the same string. */
export function seedTag(seed: number, scenario?: string): string {
  return scenario === undefined ? `[seed=${seed}]` : `[${scenario} seed=${seed}]`;
}

/**
 * The seeds a scenario runs. Default = the fixed CI set (1–10). `CHAOS_NIGHTLY=1` switches to 100
 * PRNG-chosen seeds (logged, per §3.7 — a nightly failure reproduces from its printed seed alone).
 * `CHAOS_SEEDS=3,7,42` overrides both — the local one-liner that reproduces a specific nightly seed.
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
    // Log the whole set so any nightly failure is reproducible via CHAOS_SEEDS=<printed>.

    console.log(`[chaos:nightly] runSeed=${runSeed} seeds=${seeds.join(',')}`);
    return seeds;
  }
  return [...CI_SEEDS];
}

/**
 * Run `body(seed)` and, on any throw, re-throw the SAME error with `[seed=…]` prefixed so the
 * failure output alone reproduces the run. Returns the body's value on success.
 */
export async function withSeed<T>(
  seed: number,
  body: (seed: number) => Promise<T> | T,
  scenario?: string,
): Promise<T> {
  try {
    return await body(seed);
  } catch (error) {
    const tag = seedTag(seed, scenario);
    if (error instanceof Error) {
      error.message = `${tag} ${error.message}`;
      throw error;
    }
    throw new Error(`${tag} ${String(error)}`);
  }
}
