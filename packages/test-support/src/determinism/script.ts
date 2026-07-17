// generateScript — the deterministic notes workload of the chaos harness (testing-guide §3.3).
//
// Produces a driver- AND module-agnostic sequence of op DESCRIPTORS: the harness fixture maps
// each descriptor to a real `notes` command executed on the authoring device (which stamps the
// timestamp from that device's FakeClock and signs+chains via the production append path). The
// generator therefore owns NO protocol logic (T-7) and does not import the notes module — it
// only decides WHAT each device does, deterministically from one uint32 seed (T-6).
//
// Mix (§3.3): 20% createNote, 60% editNoteBody (target biased toward the 5 most recent entities
// — forces same-entity contention across devices), 15% archiveNote, 5% media-attach. Entities
// live in a single shared, creation-ordered namespace so an edit authored by one device can
// target a note created by another (the out-of-order / re-fold pressure CHAOS-01 needs). Each op
// advances its device's clock by a PRNG-chosen 1–600 s. A v1→v2 schema cutover seam (§3.2, 04 §3)
// is honored at `cutoverIndex` in the global sequence.

import { randomInt, type Prng } from './prng.js';

/** The four command kinds the notes workload issues (§3.3). */
export type ScriptOpKind = 'createNote' | 'editNoteBody' | 'archiveNote' | 'mediaAttach';

/** Recency window: target selection is biased toward the last N created entities (§3.3). */
export const RECENCY_WINDOW = 5;

/** One scripted op — engine/module-agnostic; the fixture resolves `entity` to a real UUID. */
export interface ScriptOp {
  /** Authoring device index, `[0, deviceCount)`. */
  readonly device: number;
  readonly kind: ScriptOpKind;
  /**
   * Shared entity ordinal (creation order across ALL devices). For `createNote` this is the NEW
   * entity's ordinal; for the others it is the target, always `< ` the number of prior creates.
   */
  readonly entity: number;
  /** v1 before `cutoverIndex`, v2 at/after — the migration seam (§3.2, 04 §3). */
  readonly schemaVersion: 1 | 2;
  /** ms to advance the authoring device's FakeClock before executing (PRNG-chosen 1–600 s). */
  readonly clockAdvanceMs: number;
  /** Per-op unique, seed-derived value (a note body / marker) — T-3, no shared magic constants. */
  readonly value: string;
}

export interface GenerateScriptOptions {
  /** Ops authored by EACH device (CHAOS-01: 500). */
  readonly opsPerDevice: number;
  /** Number of virtual devices (default fixture N = 4). */
  readonly deviceCount: number;
  /** Global op ordinal at which payloads switch v1 → v2. */
  readonly cutoverIndex: number;
}

const MIN_ADVANCE_MS = 1_000; // 1 s
const MAX_ADVANCE_MS = 600_000; // 600 s

/** Pick a kind by cumulative thresholds → expected mix 20/60/15/5. */
function pickKind(r: number): ScriptOpKind {
  if (r < 0.2) return 'createNote';
  if (r < 0.8) return 'editNoteBody';
  if (r < 0.95) return 'archiveNote';
  return 'mediaAttach';
}

/** Choose a target ordinal from `[0, pool)`, biased 30% toward the last `RECENCY_WINDOW`. */
function pickTarget(prng: Prng, pool: number): number {
  if (prng() < 0.3) {
    const window = Math.min(RECENCY_WINDOW, pool);
    return pool - window + randomInt(prng, 0, window - 1);
  }
  return randomInt(prng, 0, pool - 1);
}

/**
 * Generate the full deterministic script. Ops are returned in global (round-robin) execution
 * order; each names its authoring device, so a per-device view is `script.filter(o => o.device === d)`.
 */
export function generateScript(prng: Prng, options: GenerateScriptOptions): ScriptOp[] {
  const { opsPerDevice, deviceCount, cutoverIndex } = options;
  const total = opsPerDevice * deviceCount;
  const script: ScriptOp[] = [];
  let pool = 0; // entities created so far (shared, creation-ordered namespace)

  for (let i = 0; i < total; i += 1) {
    const device = i % deviceCount;
    let kind = pickKind(prng());
    // Nothing to edit/archive/attach-to until at least one note exists (only bites at i = 0).
    if (kind !== 'createNote' && pool === 0) kind = 'createNote';

    let entity: number;
    if (kind === 'createNote') {
      entity = pool;
      pool += 1;
    } else {
      entity = pickTarget(prng, pool);
    }

    const schemaVersion: 1 | 2 = i < cutoverIndex ? 1 : 2;
    const clockAdvanceMs = randomInt(prng, MIN_ADVANCE_MS, MAX_ADVANCE_MS);
    const token = randomInt(prng, 0, 0xffff_ffff).toString(16).padStart(8, '0');

    script.push({ device, kind, entity, schemaVersion, clockAdvanceMs, value: `op${i}-${token}` });
  }

  return script;
}
