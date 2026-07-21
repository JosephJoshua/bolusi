// SEED-200K — the year-equivalent local history the Part C gates seed on-device (testing-guide
// §4.1). It SCALES the §3.3 determinism kit (the same `mulberry32` PRNG and the same `ScriptOp`
// descriptor the chaos harness replays) to one device-year of a busy store's op stream, so the
// on-device rebuild / execute-latency / write-throughput gates run over a realistic, REPRODUCIBLE
// history rather than a hand-picked one. Everything flows from one uint32 seed (T-6); nothing here
// touches a DB driver or the filesystem (08 §3.3 — the fixture maps each descriptor to a real
// `notes` command on-device).
//
// WHY A DEDICATED GENERATOR AND NOT A BARE `generateScript` CALL. `generateScript` pins the chaos
// workload's mix (20/60/15/5) which the chaos harness (task 26) depends on byte-for-byte — it is not
// mine to retune. SEED-200K's composition is DIFFERENT and exact: §4.1 fixes ~20,000 entities (~10
// ops each) and 5,000 MediaItem metadata rows over 200,000 ops, which a 20%-create mix cannot
// produce (that is 40,000 entities). So this generator owns its own composition while reusing the
// kit's PRNG + op shape. The counts are EXACT by construction (a shuffled multiset), so a silent
// widening that halves the entity count — and so the rebuild cost — is a visible red in
// `seed-200k.test.ts`, not a quietly easier gate.
import { RECENCY_WINDOW, type ScriptOp, type ScriptOpKind } from '../determinism/script.js';
import { randomInt, shuffle, type Prng } from '../determinism/prng.js';

/**
 * The SEED-200K composition (testing-guide §4.1). Pinned as DATA so the on-device rebuild runner and
 * the CI determinism test read ONE source of truth (§2.8) and any change is a reviewable diff.
 */
export interface Seed200kSpec {
  /** Total operations in the year-equivalent history. */
  readonly totalOps: number;
  /** Distinct entities (`createNote` ops) — ~10 ops each at 200k / 20k. */
  readonly entityCount: number;
  /** MediaItem metadata rows (`mediaAttach` ops). */
  readonly mediaRows: number;
  /** Global op ordinal at which payloads switch v1 → v2 (§3.2, 04 §3): v1 for `i < cutover`. */
  readonly cutoverIndex: number;
}

export const SEED_200K: Seed200kSpec = Object.freeze({
  totalOps: 200_000,
  entityCount: 20_000,
  mediaRows: 5_000,
  cutoverIndex: 100_000,
});

const MIN_ADVANCE_MS = 1_000; // 1 s
const MAX_ADVANCE_MS = 600_000; // 600 s

/**
 * Choose a target ordinal from `[0, pool)`, biased 30% toward the last `RECENCY_WINDOW` created
 * entities — the same recency pressure §3.3 uses so the seed exercises same-entity edit chains
 * (the head-case op-sqlite fold the rebuild gate measures) rather than a uniform spray.
 */
function pickTarget(prng: Prng, pool: number): number {
  if (prng() < 0.3) {
    const window = Math.min(RECENCY_WINDOW, pool);
    return pool - window + randomInt(prng, 0, window - 1);
  }
  return randomInt(prng, 0, pool - 1);
}

/**
 * Build the exact kind multiset (§4.1). `editNoteBody` : `archiveNote` keeps §3.3's 60:15 = 4:1
 * ratio over whatever remains after the fixed create/media counts, so the non-create mix still
 * looks like the chaos workload.
 */
function kindMultiset(spec: Seed200kSpec): ScriptOpKind[] {
  const remaining = spec.totalOps - spec.entityCount - spec.mediaRows;
  const editCount = Math.round((remaining * 4) / 5);
  const archiveCount = remaining - editCount;
  return [
    ...(Array(spec.entityCount).fill('createNote') as ScriptOpKind[]),
    ...(Array(editCount).fill('editNoteBody') as ScriptOpKind[]),
    ...(Array(archiveCount).fill('archiveNote') as ScriptOpKind[]),
    ...(Array(spec.mediaRows).fill('mediaAttach') as ScriptOpKind[]),
  ];
}

/**
 * Generate SEED-200K from one PRNG. Deterministic and byte-identical per seed; seed 42 is the
 * canonical history (§4.1). All 200k ops author on device 0 — SEED-200K is ONE device's local
 * projection history (the P-2 rebuild subject), not a multi-device convergence run (that is CHAOS).
 */
export function generateSeed200k(prng: Prng, spec: Seed200kSpec = SEED_200K): ScriptOp[] {
  // Shuffle the exact multiset so creates are spread across the whole history (entities accrue
  // steadily, ~10 ops each land over the year) rather than all up front.
  const kinds = shuffle(prng, kindMultiset(spec));
  // Position 0 MUST be a create so every later non-create has an existing target. Swapping the
  // first create to the front preserves the multiset (so the exact counts hold).
  const firstCreate = kinds.indexOf('createNote');
  if (firstCreate > 0) {
    [kinds[0], kinds[firstCreate]] = [kinds[firstCreate] as ScriptOpKind, kinds[0] as ScriptOpKind];
  }

  const script: ScriptOp[] = [];
  let pool = 0; // entities created so far (shared, creation-ordered namespace)

  for (let i = 0; i < spec.totalOps; i += 1) {
    const kind = kinds[i] as ScriptOpKind;
    let entity: number;
    if (kind === 'createNote') {
      entity = pool;
      pool += 1;
    } else {
      entity = pickTarget(prng, pool);
    }

    const schemaVersion: 1 | 2 = i < spec.cutoverIndex ? 1 : 2;
    const clockAdvanceMs = randomInt(prng, MIN_ADVANCE_MS, MAX_ADVANCE_MS);
    const token = randomInt(prng, 0, 0xffff_ffff).toString(16).padStart(8, '0');

    script.push({
      device: 0,
      kind,
      entity,
      schemaVersion,
      clockAdvanceMs,
      value: `op${i}-${token}`,
    });
  }

  return script;
}
