// Volume parameterization (testing-guide §3.6 volumes; §3.7 CI-scale vs nightly ×4).
//
// The §3.6 catalog fixes exact CI-scale volumes (CHAOS-02: 1,600 + 1,600; CHAOS-03: ~14,000;
// CHAOS-08: 20,000 + 500 interleaved). The acceptance forbids SILENTLY reduced volume — so the
// CI numbers live here as named constants a reviewer can diff against the spec, and the nightly
// multiplier (×4) is applied by ONE function, never by a scattered literal. Task 27 reuses the
// same scenarios at device-reduced volume by passing a `Volumes` with a smaller scale.
//
// `scale` multiplies the op counts; device counts are NOT scaled (a scenario's device topology is
// part of its meaning, not its volume). The env seam (`CHAOS_SCALE`) lets the nightly job pass ×4
// without a code change, and the meta-test asserts the CI defaults match the spec exactly.

/** The exact op/device volumes each scenario drives. `scale` multiplies op counts only. */
export interface Volumes {
  /** Multiplier on op counts. 1 = CI scale (the §3.6 numbers); 4 = nightly. */
  readonly scale: number;
  /** CHAOS-01: ops authored per device (3 devices). */
  readonly outOfOrderOpsPerDevice: number;
  /** CHAOS-02: local ops (== foreign ops); each side is 4 push/pull batches of ≤ 500. */
  readonly interruptedOpsPerSide: number;
  /** CHAOS-03: devices × days × ops/day ≈ 14,000 total. */
  readonly bulkDevices: number;
  readonly bulkDays: number;
  readonly bulkOpsPerDay: number;
  /** CHAOS-08: rebuild history + the mid-stream interleaved ops. */
  readonly rebuildHistory: number;
  readonly rebuildInterleaved: number;
}

/** CI-scale volumes — the §3.6 numbers verbatim (the meta-test pins these). */
export const CI_VOLUMES: Volumes = {
  scale: 1,
  outOfOrderOpsPerDevice: 500,
  interruptedOpsPerSide: 1_600,
  bulkDevices: 4,
  bulkDays: 7,
  bulkOpsPerDay: 500, // 4 × 7 × 500 = 14,000
  rebuildHistory: 20_000,
  rebuildInterleaved: 500,
};

/** Apply a scale to the op counts (device/day topology is unscaled — it is meaning, not volume). */
export function scaled(base: Volumes, scale: number): Volumes {
  return {
    scale,
    outOfOrderOpsPerDevice: base.outOfOrderOpsPerDevice * scale,
    interruptedOpsPerSide: base.interruptedOpsPerSide * scale,
    bulkDevices: base.bulkDevices,
    bulkDays: base.bulkDays,
    bulkOpsPerDay: base.bulkOpsPerDay * scale,
    rebuildHistory: base.rebuildHistory * scale,
    rebuildInterleaved: base.rebuildInterleaved * scale,
  };
}

/**
 * Resolve the active volumes from the environment: default CI scale, `CHAOS_SCALE=4` for nightly.
 * A single seam so a scenario never reads the env directly and the ×4 is applied in one place.
 */
export function activeVolumes(env: NodeJS.ProcessEnv = process.env): Volumes {
  const raw = env.CHAOS_SCALE;
  const scale = raw === undefined ? 1 : Number.parseInt(raw, 10);
  if (!Number.isInteger(scale) || scale < 1) {
    throw new Error(`CHAOS_SCALE must be a positive integer, got ${String(raw)}`);
  }
  return scale === 1 ? CI_VOLUMES : scaled(CI_VOLUMES, scale);
}
