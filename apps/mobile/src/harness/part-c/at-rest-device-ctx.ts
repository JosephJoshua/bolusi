// SEC-DEV-06's L6 at-rest leg, wired to REAL SQLCipher on the emulator (task 27a; security-guide
// §6.5, testing-guide T-14b). This is the ONLY place real SQLCipher ever runs — CI has none
// (better-sqlite3 ships none; op-sqlite is JSI, dead on a Linux host). The probe LOGIC and its
// positive control are unit-proven in `@bolusi/test-support` (driver-conformance/at-rest.ts); this
// file is the device CONTEXT that feeds them a real encrypted DB and a real unencrypted control DB.
//
// THE CRUX (T-14b). `checkDbAtRestIsCiphertext` passes when the seeded markers are ABSENT from the
// SQLCipher file — which is ALSO what a silent seed no-op produces. So this ctx runs the POSITIVE
// CONTROL FIRST: it writes the SAME markers to a throwaway UNENCRYPTED control DB and asserts they
// ARE byte-present there. Only if the seed provably lands marker bytes on disk does absence in the
// ciphertext mean anything. Without the control, "no plaintext found" proves nothing (the
// parse-collapse / empty-fixture family).
import {
  checkControlSeedIsWitnessed,
  checkDbAtRestIsCiphertext,
  type AtRestProbeContext,
} from '@bolusi/test-support';

import { failed, passed, type HarnessGateResult } from '../result.js';

/** The gate id this runner reports under (matches `EMULATOR_REQUIRED_GATES` in harness-device.mjs). */
export const AT_REST_GATE_ID = 'SEC-DEV-06-at-rest';

/**
 * The device seams the at-rest gate needs. All INJECTED so this file imports no DB driver — the real
 * op-sqlite bindings are supplied at the app's one native-binding site (index.ts), exactly like the
 * production data layer. A CI test drives it with fakes to prove the ORCHESTRATION (control first,
 * short-circuit on a vacuous seed).
 */
export interface AtRestDeviceEnv {
  /** Values seeded into both DBs; none may survive as plaintext in the SQLCipher file. */
  readonly plaintextMarkers: readonly string[];
  /** Seed the markers into a throwaway UNENCRYPTED control DB and return its raw file bytes. */
  seedUnencryptedControl(markers: readonly string[]): Promise<Uint8Array>;
  /** Seed the markers into the real SQLCipher DB and return a probe ctx over a COPY of it. */
  seedEncryptedDb(markers: readonly string[]): Promise<AtRestProbeContext>;
}

/**
 * Run SEC-DEV-06's at-rest leg. Positive control FIRST — a failed control short-circuits to a red
 * gate WITHOUT trusting the ciphertext result, because that result would be vacuous.
 */
export async function runAtRestGate(env: AtRestDeviceEnv): Promise<HarnessGateResult> {
  const markers = env.plaintextMarkers;

  const controlBytes = await env.seedUnencryptedControl(markers);
  const controlFindings = checkControlSeedIsWitnessed(controlBytes, markers);
  if (controlFindings.length > 0) {
    return failed(
      AT_REST_GATE_ID,
      `positive control FAILED — the seed did not land marker bytes even in an UNENCRYPTED control ` +
        `DB, so ciphertext-absence proves nothing (T-14b): ${controlFindings
          .map((finding) => finding.detail)
          .join('; ')}`,
    );
  }

  const ctx = await env.seedEncryptedDb(markers);
  const findings = await checkDbAtRestIsCiphertext(ctx);
  if (findings.length > 0) {
    return failed(
      AT_REST_GATE_ID,
      `DB at rest is NOT ciphertext: ${findings.map((f) => `${f.check} — ${f.detail}`).join('; ')}`,
    );
  }
  return passed(
    AT_REST_GATE_ID,
    'DB at rest is ciphertext: unkeyed + wrong-key opens refused, no plaintext header, seeded ' +
      'markers absent — and the positive control witnessed the seed in an unencrypted control DB',
  );
}
