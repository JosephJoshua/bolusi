// Extended chaos runs sample the expensive scenarios at full volume.
// Explicit CHAOS_SEEDS reproductions always keep the requested seeds.
import { activeVolumes } from './volumes.js';

/**
 * The scenarios whose ×4 nightly lane runs against a capped SEED SAMPLE, and the sample size.
 * Per-scenario because the three costs differ by an order of magnitude; both sized so the file fits
 * inside a practical local runtime budget:
 *
 * - `CHAOS-02` → **3** seeds. Six fault/control cases per seed at ×4, plus one
 *   negative control; one F1 push case took 210 s locally (2026-10-13).
 * - `CHAOS-03` → **3** seeds. ≈ 40 min/seed at ×4 (56,000 ops) ⇒ ≈ 2 h quiet, the long pole.
 * - `CHAOS-08` → **5** seeds. ≈ 3.6 min/seed at ×4 (80,000-op rebuild) ⇒ ≈ 18 min quiet.
 *
 * Every other scenario keeps the FULL nightly seed set (100) at ×4 — this is a three-row exception,
 * not a general trim, and adding a row is a deliberate, documented, asserted act.
 */
export const NIGHTLY_X4_SEED_CAPS = {
  'CHAOS-02': 3,
  'CHAOS-03': 3,
  'CHAOS-08': 5,
} as const;

/** A scenario that declares itself heavy enough to need the ×4 seed cap. */
export type X4CappedScenario = keyof typeof NIGHTLY_X4_SEED_CAPS;

/** Env override for a deliberately deeper (or shallower) ×4 nightly — must be an integer ≥ 1. */
export const X4_SEED_CAP_ENV = 'CHAOS_X4_SEED_CAP';

/**
 * True only on the nightly ×4 LANE: `CHAOS_NIGHTLY=1` at a scale > 1, with no explicit
 * `CHAOS_SEEDS=`. An explicit seed list is a REPRODUCTION and is never capped — that is guardrail
 * #2 of §3.7 (the printed reproduction command must run verbatim).
 */
export function isNightlyX4Lane(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env.CHAOS_SEEDS !== undefined && env.CHAOS_SEEDS !== '';
  if (explicit) return false;
  if (env.CHAOS_NIGHTLY !== '1') return false;
  return activeVolumes(env).scale > 1;
}

/** The cap in force for `scenario` — the registry value unless the env override says otherwise. */
export function x4SeedCap(
  scenario: X4CappedScenario,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[X4_SEED_CAP_ENV];
  if (raw === undefined || raw === '') return NIGHTLY_X4_SEED_CAPS[scenario];
  const override = Number.parseInt(raw, 10);
  // A cap of 0 would resolve ZERO seeds and the scenario would report green having run NOTHING
  // (T-14 — a guard that silently checks nothing is worse than no guard). Refuse it loudly.
  if (!Number.isInteger(override) || override < 1) {
    throw new Error(`${X4_SEED_CAP_ENV} must be an integer ≥ 1, got ${String(raw)}`);
  }
  return override;
}

/**
 * Apply the nightly ×4 seed cap to a heavy scenario's resolved seed list. Off the ×4 nightly lane
 * (CI, explicit `CHAOS_SEEDS=`, a hand-run `CHAOS_NIGHTLY=1` at ×1) this returns `seeds` unchanged.
 *
 * Throws on an empty input: a configuration that resolves ZERO seeds must FAIL, never pass
 * vacuously with an empty `for (const seed of …)` loop that collects no tests at all (T-14).
 */
export function nightlyX4Seeds(
  scenario: X4CappedScenario,
  seeds: readonly number[],
  env: NodeJS.ProcessEnv = process.env,
): number[] {
  if (seeds.length === 0) {
    throw new Error(`${scenario}: resolved ZERO seeds — a run that tests nothing is a failure`);
  }
  if (!isNightlyX4Lane(env)) return [...seeds];

  const cap = x4SeedCap(scenario, env);
  const sampled = seeds.slice(0, cap);
  if (sampled.length === 0) {
    throw new Error(`${scenario}: ×4 seed cap ${cap} resolved ZERO seeds from ${seeds.length}`);
  }
  // Announce it in the run log: the nightly output states, per scenario, that it sampled and by how
  // much — so "×4 × 100 seeds" can never be read off a run that sampled 3 (§2.11).
  console.log(
    `[chaos:nightly] ${scenario} ×${activeVolumes(env).scale} seed cap: running ${sampled.length}` +
      ` of ${seeds.length} nightly seeds (${sampled.join(',')}) — testing-guide §3.7 D-CHAOS-SCALE`,
  );
  return sampled;
}
