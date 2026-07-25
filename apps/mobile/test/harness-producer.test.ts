// The PRODUCER ↔ DRIVER contract (task 27a/175 deliverables #2 + #3). Task 175 proved the emulator lane
// waited 20 minutes for a logcat line NOTHING in this repo wrote: no emitter, no caller of
// `loadHarness()`, and — the trap — a driver that filters logcat by the TAG `BOLUSI_HARNESS_RESULT`
// while a JS `console.log` would land under `ReactNativeJS`. This suite falsifies, without a device,
// the two halves that MUST agree:
//
//   1. the emitter writes under EXACTLY the tag the driver filters on, and
//   2. the document the producer assembles parses through the REAL driver — as an HONEST PARTIAL while
//      the gate bodies are unwired (every required gate `skipped`, the lane RED and naming each), never
//      a green-for-nothing (§2.11).
//
// It imports the producer's PURE pieces (run.ts/flag.ts/registry.ts — no RN, no native module) and the
// real driver `.mjs`, so the only thing left unproven is the on-device wire itself (native `Log.i` and
// the APK boot), which is the CI runner's job.
import { describe, expect, test } from 'vitest';

import { HARNESS_RESULT_SCHEMA, HARNESS_RESULT_TAG } from '../src/harness/flag.js';
import { EMULATOR_CORRECTNESS_GATE_IDS } from '../src/harness/gates.js';
import { failed, passed, type HarnessGateResult } from '../src/harness/result.js';
import { buildHarnessResult, resolveGateResults } from '../src/harness/run.js';

// Plain .mjs CLI — resolved as JS under this package's `allowJs` (types are inferred, not declared).
import * as driver from '../../../scripts/harness-device.mjs';

const RUN_ID = 'run-produced-2026-07-25T00-00-00-abcdef';

/** Wrap a produced document the way a NATIVE `android.util.Log.i(TAG, json)` line reaches logcat: the
 * TAG is the driver's exact literal, which is the whole point — a `console.log` would be `ReactNativeJS`
 * and the driver's `-s ${TAG}:I` filter would delete it before the parser ever ran (task 175 leg 2). */
function nativeLogLine(doc: unknown): string {
  return [
    '07-25 00:00:00.000  4321  4321 I ReactNativeJS: harness starting',
    `07-25 00:00:01.500  4321  4321 I ${driver.HARNESS_RESULT_TAG as string}: ${JSON.stringify(doc)}`,
  ].join('\n');
}

describe('producer ↔ driver wire contract', () => {
  test('the emitter tag equals the tag the driver filters/greps on (leg 2 — chosen together)', () => {
    // The producer emits under flag.ts:HARNESS_RESULT_TAG (see emit.ts). The driver polls
    // `-s ${HARNESS_RESULT_TAG}:I` and greps the same substring. If these ever drift, the driver sees a
    // permanent empty capture — exactly CI run 29990800850, now with a producer in place.
    expect(HARNESS_RESULT_TAG).toBe('BOLUSI_HARNESS_RESULT');
    expect(HARNESS_RESULT_TAG).toBe(driver.HARNESS_RESULT_TAG);
  });

  test('the emitter schema equals the schema the driver validates', () => {
    expect(HARNESS_RESULT_SCHEMA).toBe(driver.HARNESS_RESULT_SCHEMA);
  });

  test('the producer emits a result for EXACTLY the driver-required gates (no missing, no extra)', () => {
    // A denominator pin (T-14): the producer's required-id set is the driver's required set, so a real
    // run fails on `skipped` (a gate that RAN and was not green) rather than `missing gate` (a gate the
    // producer forgot) — and a shrunk producer set cannot quietly pass by emitting fewer gates.
    expect([...EMULATOR_CORRECTNESS_GATE_IDS]).toEqual([
      ...(driver.EMULATOR_REQUIRED_GATES as string[]),
    ]);
  });

  test('the honest partial parses through the REAL driver and is RED, naming every skipped gate', async () => {
    // `null` = the flag-off `loadHarness()`: every gate skips honestly regardless of any runners, which
    // is the runtime half of the harness lock. The driver contract asserted here (RED, names each
    // skipped gate, shape valid) is what a flagless build emits.
    const gates = await resolveGateResults(null);
    const doc = buildHarnessResult(RUN_ID, gates, {
      profile: 'test',
      variant: 'release',
      target: 'emulator',
      hermesVersion: '0.17.0',
    });
    const verdict = driver.parseHarnessResult(nativeLogLine(doc), { expectedRunId: RUN_ID });

    // NOT ok — a skipped gate is not a pass. This is the §2.11 shape: the lane goes red and SAYS WHY,
    // instead of the pre-175 "no result emitted" silence or a fabricated green.
    expect(verdict.ok).toBe(false);
    const joined = verdict.errors.join('\n');
    for (const id of driver.EMULATOR_REQUIRED_GATES as string[]) {
      expect(joined, `driver must name skipped gate ${id}`).toContain(id);
    }
    expect(joined).toContain('skipped');
    // The document SHAPE was accepted (schema/variant/target/run-id all valid) — the ONLY failures are
    // the honest skips. If the shape were wrong we would also see schema/variant/target errors.
    expect(joined).not.toMatch(/schema|variant|target|run id/i);
  });

  test('POSITIVE CONTROL — the SAME document shape parses GREEN when the gates pass', () => {
    // Proves the RED above is the skips, not a latent shape bug: swap `skipped` for `pass` on the exact
    // same builder and the real driver accepts it. So once a runner returns `passed(id, …)`, this
    // pipeline goes green with no driver change.
    const gates: HarnessGateResult[] = (driver.EMULATOR_REQUIRED_GATES as string[]).map((id) =>
      passed(id, 'wired'),
    );
    const doc = buildHarnessResult(RUN_ID, gates, {
      profile: 'test',
      variant: 'release',
      target: 'emulator',
      hermesVersion: '0.17.0',
    });
    const verdict = driver.parseHarnessResult(nativeLogLine(doc), { expectedRunId: RUN_ID });
    expect(verdict.errors).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});

// The task-178 wiring seam: `resolveGateResults(harness, runners)` runs an injected runner for a gate
// that has one, and skips honestly for a gate that does not. These prove the seam can go BOTH ways
// (§2.11) WITHOUT a device — an always-skip resolver (the pre-178 state) and an always-pass resolver are
// the two failure shapes this guards against.
const nonNullHarness = { requiredGateIds: EMULATOR_CORRECTNESS_GATE_IDS } as unknown as Parameters<
  typeof resolveGateResults
>[0];

describe('resolveGateResults — the injected-runner seam (task 178)', () => {
  test('a runner that PASSES makes its gate green; a gate with no runner skips honestly', async () => {
    const id = EMULATOR_CORRECTNESS_GATE_IDS[0] as string;
    const gates = await resolveGateResults(nonNullHarness, {
      [id]: () => Promise.resolve(passed(id, 'runner ran on device')),
    });
    const ran = gates.find((g) => g.id === id);
    expect(ran?.status).toBe('pass');
    // Every OTHER required gate has no runner here, so it must be an honest skip — never a fabricated pass.
    for (const other of EMULATOR_CORRECTNESS_GATE_IDS) {
      if (other === id) continue;
      expect(gates.find((g) => g.id === other)?.status).toBe('skipped');
    }
  });

  test('a runner that RETURNS a fail reds its gate; a runner that THROWS also reds it, naming the id', async () => {
    const failId = EMULATOR_CORRECTNESS_GATE_IDS[0] as string;
    const throwId = EMULATOR_CORRECTNESS_GATE_IDS[1] as string;
    const gates = await resolveGateResults(nonNullHarness, {
      [failId]: () => Promise.resolve(failed(failId, 'the seeded column was plaintext')),
      [throwId]: () => Promise.reject(new Error('op-sqlite blew up')),
    });
    expect(gates.find((g) => g.id === failId)?.status).toBe('fail');
    const threw = gates.find((g) => g.id === throwId);
    expect(threw?.status).toBe('fail');
    // A crash is turned into a RED that names the gate and says it THREW — not a silent gap (§2.11).
    expect(threw?.detail).toContain(throwId);
    expect(threw?.detail).toContain('THREW');
  });

  test('with the flag OFF (harness null) an injected runner is IGNORED — the lock is runtime, not just build', async () => {
    const id = EMULATOR_CORRECTNESS_GATE_IDS[0] as string;
    // A runner that would PASS is present, but harness===null must force a skip anyway.
    const gates = await resolveGateResults(null, {
      [id]: () => Promise.resolve(passed(id, 'should never run')),
    });
    expect(gates.every((g) => g.status === 'skipped')).toBe(true);
  });
});
