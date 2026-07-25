// Host proof of the SEC-OPLOG-06 JCS runner (task 178). The runner replays the shared RFC 8785 vectors
// through the REAL `canonicalizeJcs`; on Node (V8) they all agree, so the gate passes. The on-device
// PASS (Hermes) is the emulator's to confirm — but the runner's LOGIC, and that it can go RED, are fully
// host-falsifiable here: inject a mutated expected value and the gate reds; hand it an empty vector set
// and the denominator guard reds it rather than passing vacuously (§2.11).
import { describe, expect, test } from 'vitest';

import {
  JCS_GATE_ID,
  runJcsGate,
  SHARED_JCS_VECTORS,
  type JcsVectorSet,
} from './jcs-device-runner.js';

// Titles keep the SEC id OUT deliberately (security-guide §2.1.6): this is the Node (V8) leg; the
// on-device (Hermes) proof — the shipped claim — is the emulator's, so a green here must not read as it.
describe('runJcsGate — the shared RFC 8785 JCS runner (task 178; Node leg)', () => {
  test('PASS: the shared RFC 8785 golden vectors all agree with canonicalizeJcs on this engine', async () => {
    const gate = await runJcsGate();
    expect(gate.id).toBe(JCS_GATE_ID);
    expect(gate.status, gate.detail).toBe('pass');
    // The denominator is real and reported, not zero (T-14).
    expect(gate.figures?.['numberVectors']).toBeGreaterThan(0);
    expect(gate.figures?.['canonicalizationVectors']).toBeGreaterThan(0);
  });

  test('FALSIFICATION: a single mutated expected value reds the gate', async () => {
    // Flip the expected text of the first serializable number vector — canonicalizeJcs will emit the
    // CORRECT value, which no longer matches, so the gate must go red naming the divergence.
    const index = SHARED_JCS_VECTORS.numberVectors.findIndex((v) => v.expected !== null);
    expect(index).toBeGreaterThanOrEqual(0);
    const mutated: JcsVectorSet = {
      ...SHARED_JCS_VECTORS,
      numberVectors: SHARED_JCS_VECTORS.numberVectors.map((vector, i) =>
        i === index ? { ...vector, expected: `${vector.expected ?? ''}-TAMPERED` } : vector,
      ),
    };
    const gate = await runJcsGate(mutated);
    expect(gate.status).toBe('fail');
    expect(gate.detail.toLowerCase()).toContain('diverged');
  });

  test('FALSIFICATION: an empty vector set reds the gate (denominator, T-14) — never a vacuous pass', async () => {
    const empty: JcsVectorSet = {
      ...SHARED_JCS_VECTORS,
      numberVectors: [],
      canonicalizationVectors: [],
    };
    const gate = await runJcsGate(empty);
    expect(gate.status).toBe('fail');
    expect(gate.detail.toUpperCase()).toContain('EMPTY');
  });
});
