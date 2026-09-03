// The `BOLUSI_HARNESS_RESULT` document shape (testing-guide §2.6). The on-device harness emits ONE
// of these to logcat; `scripts/harness-device.mjs` captures and validates it. The types live on the
// mobile side (they are produced here); the parser validates the shape structurally, so the two do
// not import each other across the JS/TS boundary — the wire contract is §2.6, not a shared module.
//
// Every figure carried here is EMULATOR, never a device number (D12/D20 §1): `target` labels it, and
// only CORRECTNESS gates are honest on an emulator. Performance figures (P-1..P-6) belong to task
// 27b (physical device) and are not emitted by this lane.
import type { HARNESS_RESULT_SCHEMA } from './flag.js';

export type GateStatus = 'pass' | 'fail' | 'skipped';

/** A gate is CORRECTNESS (emulator-answerable: is a byte ciphertext, does a vector match, do devices
 * converge) or PERFORMANCE (device-only — 27b). This lane emits only correctness. */
export type GateKind = 'correctness' | 'performance';

export interface HarnessGateResult {
  readonly id: string;
  readonly kind: GateKind;
  readonly status: GateStatus;
  readonly detail: string;
  /** Raw EMULATOR figures for regression tracking only — NEVER an acceptance number (D12/D20). */
  readonly figures?: Readonly<Record<string, number>>;
}

export interface HarnessResult {
  readonly schema: typeof HARNESS_RESULT_SCHEMA;
  /** Echoes the run id `harness:device` injected — the no-stale-capture-reuse guard (§2.6). */
  readonly runId: string;
  readonly profile: string;
  /** `release` is mandatory — dev-mode JS numbers are meaningless (§2.6). */
  readonly variant: 'release' | 'debug';
  /** The EMULATOR label (D12/D20). */
  readonly target: 'emulator' | 'device';
  /** The Hermes engine the shipping APK bundles — 0.17 on RN 0.86 (D13). */
  readonly hermesVersion: string;
  /**
   * The git sha the APK was BUILT from — stamped INTO this document by the producer (from
   * `EXPO_PUBLIC_BOLUSI_BUILD_SHA`, inlined at build time), so it is part of the tamper-evident
   * artifact, not attached afterward. `device-gate-provenance.ts` prefers this over the file's
   * introducing commit when diffing the at-rest surface for freshness (task 182): a fabricated
   * artifact must now name a real sha whose tree still matches, not just re-commit an old pass.
   * `'unknown'` when the env was unset — the guard treats that as fail-closed, never a pass.
   */
  readonly buildSha: string;
  readonly gates: readonly HarnessGateResult[];
}

/** Build a passing correctness gate. */
export function passed(
  id: string,
  detail: string,
  figures?: Record<string, number>,
): HarnessGateResult {
  return { id, kind: 'correctness', status: 'pass', detail, ...(figures ? { figures } : {}) };
}

/** Build a failing correctness gate. */
export function failed(id: string, detail: string): HarnessGateResult {
  return { id, kind: 'correctness', status: 'fail', detail };
}

/**
 * Build a SKIPPED correctness gate — an honest "no runner ran this" (§2.11), NEVER a silent pass. The
 * driver treats `skipped` as not-`pass`, so it fails the lane on this id and names it: a first real run
 * with unwired gate bodies is an honest partial, not a green-for-nothing.
 */
export function skipped(id: string, detail: string): HarnessGateResult {
  return { id, kind: 'correctness', status: 'skipped', detail };
}
