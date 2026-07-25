// SEC-OPLOG-06's on-device leg: the shared RFC 8785 (JCS) golden vectors, replayed through the REAL
// `canonicalizeJcs` on the device's Hermes engine (testing-guide §2.2; 05 §3).
//
// ── WHY THIS MUST RUN ON DEVICE ─────────────────────────────────────────────────────────────────
// JCS number output is ES `Number → string` — an engine-implemented algorithm (shortest round-tripping
// representation). If Hermes and V8 disagreed on ANY vector, two devices would hash DIFFERENT preimages
// and the mismatch would surface far away as BAD_SIGNATURE (05 §8). The Node stage-5 suite proves it on
// V8; THIS runner proves the identical assertions on Hermes, against the SAME golden JSON (T-5 — one
// fixture, reached via `@bolusi/test-support/device`, never a device-only copy). `canonicalizeJcs` and
// the byte helpers come from `@bolusi/core` (platform-free), so nothing here pulls `node:crypto`.
//
// It is a PURE runner (no DB, no filesystem), so its logic is fully host-falsifiable: the host test
// replays the same vectors on Node and watches a mutated expected value turn the gate RED.
import { bytesToHex, canonicalizeJcs, JcsInputError, utf8ToBytes } from '@bolusi/core';
import {
  canonicalizationVectors,
  ieee754HexToNumber,
  numberVectors,
  propertySortingVector,
  type CanonicalizationVector,
  type NumberVector,
  type PropertySortingVector,
} from '@bolusi/test-support/device';

import { failed, passed, type HarnessGateResult } from '../result.js';

/** The gate id this runner reports under (matches `EMULATOR_REQUIRED_GATES` in harness-device.mjs). */
export const JCS_GATE_ID = 'SEC-OPLOG-06-jcs';

type JcsInput = Parameters<typeof canonicalizeJcs>[0];

/** The vectors the runner replays. A parameter (not a hard import) so the host test can inject a
 * MUTATED set and watch the gate go RED — the shared golden set is the default, so production replays
 * exactly the SEC-OPLOG-06 fixture (T-5). */
export interface JcsVectorSet {
  readonly numberVectors: readonly NumberVector[];
  readonly canonicalizationVectors: readonly CanonicalizationVector[];
  readonly propertySortingVector: PropertySortingVector;
  readonly ieee754HexToNumber: (hex: string) => number;
}

/** The shared RFC 8785 golden vectors — the real on-device subject. */
export const SHARED_JCS_VECTORS: JcsVectorSet = {
  numberVectors,
  canonicalizationVectors,
  propertySortingVector,
  ieee754HexToNumber,
};

/**
 * Replay every shared RFC 8785 vector through `canonicalizeJcs` and return a real verdict.
 *
 * DENOMINATOR (T-14): a vacuous run — zero vectors — must NOT pass. The vector arrays are asserted
 * non-empty before any per-vector check, so an empty golden file reds the gate rather than passing it
 * for the wrong reason (§2.11's empty-fixture family).
 */
export function runJcsGate(vectors: JcsVectorSet = SHARED_JCS_VECTORS): Promise<HarnessGateResult> {
  const { numberVectors, canonicalizationVectors, propertySortingVector, ieee754HexToNumber } =
    vectors;
  const findings: string[] = [];

  // 0. Denominator. The Node suite pins exact counts (26 number vectors, 2 must-error); on device we
  //    at minimum refuse a vacuous fixture, so "all vectors passed" cannot mean "there were none".
  if (numberVectors.length === 0 || canonicalizationVectors.length === 0) {
    return Promise.resolve(
      failed(
        JCS_GATE_ID,
        `the shared JCS golden vectors are EMPTY on device (numberVectors=${numberVectors.length}, ` +
          `canonicalizationVectors=${canonicalizationVectors.length}) — a vacuous pass is not a pass (T-14)`,
      ),
    );
  }

  // 1. RFC 8785 Appendix B number serialization — the Hermes-vs-V8 crux.
  let numberChecks = 0;
  for (const vector of numberVectors) {
    const value = ieee754HexToNumber(vector.ieee754);
    if (vector.expected === null) {
      // NaN / ±Infinity MUST terminate with an error (RFC 8785 §3.2.2.3).
      try {
        canonicalizeJcs(value);
        findings.push(
          `number ${vector.ieee754} (${vector.comment}) should have thrown but canonicalized instead`,
        );
      } catch (error) {
        if (!(error instanceof JcsInputError) || error.code !== 'NON_FINITE_NUMBER') {
          findings.push(
            `number ${vector.ieee754} (${vector.comment}) threw the wrong error: ${String(error)}`,
          );
        }
      }
    } else {
      const actual = canonicalizeJcs(value);
      if (actual !== vector.expected) {
        findings.push(
          `number ${vector.ieee754} (${vector.comment}) → ${JSON.stringify(actual)}, ` +
            `expected ${JSON.stringify(vector.expected)}`,
        );
      }
    }
    numberChecks += 1;
  }

  // 2. RFC 8785 §3.2 canonicalization — both the JSON text AND the exact §3.2.4 UTF-8 bytes (the real
  //    hash preimage is bytes, not a JS string).
  let canonChecks = 0;
  for (const vector of canonicalizationVectors) {
    const canonical = canonicalizeJcs(vector.input as JcsInput);
    if (canonical !== vector.expected) {
      findings.push(
        `canonicalize "${vector.name}" → ${JSON.stringify(canonical)}, expected ${JSON.stringify(vector.expected)}`,
      );
    }
    const hex = bytesToHex(utf8ToBytes(canonical));
    if (hex !== vector.expectedUtf8Hex) {
      findings.push(
        `canonicalize "${vector.name}" UTF-8 bytes ${hex}, expected ${vector.expectedUtf8Hex}`,
      );
    }
    canonChecks += 1;
  }

  // 3. RFC 8785 §3.2.3 property sorting — UTF-16 code-unit order (the surrogate-pair case is where a
  //    code-POINT sort, which Python/Go default to, would diverge).
  const sorted = canonicalizeJcs(propertySortingVector.input);
  const valuesInOrder = [...sorted.matchAll(/:"([^"]*)"/g)].map((match) => match[1]);
  const expectedOrder = propertySortingVector.expectedValueOrder;
  const orderMatches =
    valuesInOrder.length === expectedOrder.length &&
    valuesInOrder.every((value, index) => value === expectedOrder[index]);
  if (!orderMatches) {
    findings.push(
      `property sort order ${JSON.stringify(valuesInOrder)}, expected ${JSON.stringify(expectedOrder)}`,
    );
  }

  const figures = {
    numberVectors: numberChecks,
    canonicalizationVectors: canonChecks,
    propertyVectors: 1,
  };

  if (findings.length > 0) {
    return Promise.resolve(
      failed(
        JCS_GATE_ID,
        `Hermes canonicalization diverged from the shared RFC 8785 vectors: ${findings.join('; ')}`,
      ),
    );
  }
  return Promise.resolve(
    passed(
      JCS_GATE_ID,
      `Hermes canonicalizeJcs matches the shared RFC 8785 golden vectors byte-for-byte: ` +
        `${numberChecks} number, ${canonChecks} canonicalization (text + §3.2.4 UTF-8 bytes), and the ` +
        `property-sort (UTF-16 code-unit order) vectors all agree — the on-device hash preimage is ` +
        `identical to the Node engine's (SEC-OPLOG-06).`,
      figures,
    ),
  );
}
