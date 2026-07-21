// The nightly ×4 lane's PER-SCENARIO SEED CAP (testing-guide §3.7 D-CHAOS-SCALE — the third lever,
// owned by the nightly JOB rather than by a scenario's own scale policy).
//
// WHY THIS EXISTS. `chaos:nightly` runs `CHAOS_NIGHTLY=1 CHAOS_SCALE=4` — 100 PRNG seeds per
// scenario at 4× the §3.6 volumes. For the light scenarios that is a long-but-finite run. For the
// two HEAVY ones it is not runnable at all (task 113, measured from task 106):
//
//   - CHAOS-03 at ×4 = 4 devices × 7 days × 2,000 ops/day = 56,000 ops/seed. The 14,000-op case is
//     MEASURED at ~591 s on a quiet box and the cost is volume-proportional (≈90 % server
//     round-trips + Ed25519 verify), so one ×4 seed is ≈ 40 min. × 100 seeds ≈ 2.7 DAYS.
//   - CHAOS-08 at ×4 = 80,000 + 2,000 ops/seed. The 20,000-op rebuild is ~54 s, so one ×4 seed is
//     ≈ 3.6 min. × 100 seeds ≈ 6 h — the whole nightly budget for one file.
//
// A job that cannot finish is a coverage CLAIM with no coverage behind it — the exact failure mode
// D-CHAOS-SCALE exists to prevent. So the ×4 lane samples SEEDS for those two scenarios. It does
// NOT reduce the ×4 VOLUME: 4× volume is the entire point of the lane, and the cap is on the seed
// dimension only.
//
// WHY THE CAP IS NOT INSIDE THE SCENARIO HELPERS' OWN POLICY. `chaos03Seeds`/`chaos08Seeds` bound
// the CI SEED SWEEP (lever 1) and must keep returning EVERY resolved seed whenever someone asks for
// them explicitly — guardrail #2 of §3.7: a `CHAOS_SEEDS=…` reproduction, or a hand-run
// `CHAOS_NIGHTLY=1` at ×1, still runs the full set. This cap is a different lever with a different
// owner: it is scoped to the nightly ×4 LANE (`CHAOS_NIGHTLY=1` AND scale > 1 AND no explicit
// seeds), it lives in ONE registry a reviewer can diff against the doc, and it ANNOUNCES itself in
// the run log. The scenarios only declare that they are heavy by naming themselves here.
//
// NEVER SILENT (§2.11). The caps are stated in three places that are checked against each other by
// `scenarios/nightly-seed-cap.test.ts`: this registry, `.github/workflows/chaos-nightly.yml`, and
// testing-guide §3.7. That test also asserts the two heavy scenario files genuinely CALL this
// function (a mention is not a producer — T-16) and that the light scenarios do NOT, so the
// uncapped 100-seed claim for them stays true.
import { activeVolumes } from './volumes.js';

/**
 * The scenarios whose ×4 nightly lane runs against a capped SEED SAMPLE, and the sample size.
 * Per-scenario because the two costs differ by an order of magnitude; both sized so the file fits
 * inside the nightly job's 360-min ceiling with contention headroom:
 *
 * - `CHAOS-03` → **3** seeds. ≈ 40 min/seed at ×4 (56,000 ops) ⇒ ≈ 2 h quiet, the long pole.
 * - `CHAOS-08` → **5** seeds. ≈ 3.6 min/seed at ×4 (80,000-op rebuild) ⇒ ≈ 18 min quiet.
 *
 * Every other scenario keeps the FULL nightly seed set (100) at ×4 — this is a two-row exception,
 * not a general trim, and adding a row is a deliberate, documented, asserted act.
 */
export const NIGHTLY_X4_SEED_CAPS = {
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
