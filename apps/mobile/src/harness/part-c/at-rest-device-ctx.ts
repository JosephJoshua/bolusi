// SEC-DEV-06's L6 at-rest leg, run on the emulator against the REAL app-layer column cipher (task
// 27a; security-guide §6.5, 10-db §9.7, testing-guide T-14b).
//
// **NOT SQLCipher.** D22 removed it (task 148) — there is no SQLCipher anywhere in this repo any
// more. The device DB file is a plaintext SQLite file that opens with no key, BY DESIGN; what is
// ciphertext is the signed-off set of sensitive COLUMNS. This file is the device CONTEXT: it seeds
// real values through the real writers, hands the probe a copy of the real DB, and reads back the
// physically-stored cells. The probe LOGIC and its positive control are unit-proven in
// `@bolusi/test-support` (driver-conformance/at-rest.ts).
//
// THE CRUX (T-14b). The marker checks pass when the seeded plaintext is ABSENT — which is ALSO what a
// silent seed no-op produces. So this ctx runs the POSITIVE CONTROL FIRST: it writes the SAME markers
// to a throwaway control DB with the cipher DISABLED and asserts they ARE byte-present there. Only if
// the seed provably lands marker bytes on disk does absence in the real file mean anything. The probe
// additionally requires every encrypted column to have been observed, so a device that seeded nothing
// fails loudly instead of passing vacuously.
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
  /** Values seeded into both DBs; none may survive as plaintext in the real file. */
  readonly plaintextMarkers: readonly string[];
  /** Seed the markers into a throwaway control DB with the cipher DISABLED; return its raw file bytes. */
  seedUnencryptedControl(markers: readonly string[]): Promise<Uint8Array>;
  /** Seed the markers through the real writers and return a probe ctx over a COPY of the real DB. */
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
      `protected columns at rest are NOT ciphertext: ${findings
        .map((f) => `${f.check} — ${f.detail}`)
        .join('; ')}`,
    );
  }
  return passed(
    AT_REST_GATE_ID,
    'protected columns at rest are ciphertext: every signed-off column was observed and carries the ' +
      'cipher marker, no seeded plaintext survives in the file bytes — and the positive control ' +
      'witnessed the seed in a cipher-disabled control DB. The FILE itself is plain SQLite by design ' +
      '(D22): only the sensitive columns are sealed.',
  );
}
