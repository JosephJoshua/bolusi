// SEC-AUTH-09 **leg 2** (security-guide §5.4) and invariant **I-13** (01-domain-model §10; D11,
// D15b) — "no pushed op payload contains verifier material", proven over a full PIN
// set → change → reset cycle.
//
// OWNERSHIP, STATED PRECISELY (security-guide §2.1.6 — a title claims the WHOLE id, so a partial
// leg must NOT title it):
//   * **I-13 is titled here and is fully discharged here.** Task 14's `pin-flows.test.ts` proves
//     specific payloads are verifier-free PER CASE; I-13 is the UNIVERSAL claim, and this scans
//     EVERY op the cycle pushed. One test discharges the invariant; task 14 does not double-own it.
//   * **SEC-AUTH-09 is deliberately NOT titled.** Its leg 1 (verifiers exist only inside the
//     SQLCipher DB) needs REAL SQLCipher, which exists only in the emulator/device lane (task 27a):
//     better-sqlite3 ships no SQLCipher and op-sqlite is JSI, so CI cannot settle it and it must
//     never be asserted against a fake. Leg 1 is therefore recorded UNPROVEN and SEC-AUTH-09 keeps
//     its row in `sec-pending-allowlist.json`. Titling it here would retire an id whose first leg
//     nobody has run — the exact false assurance CLAUDE.md §2.11 exists to stop.
//
// FALSIFICATION (CLAUDE.md §2.11): the final verifier's `hashB64` was spliced into the scanned
// wire-byte set → "verifier material reached the wire/op log: {"payload":{"verifierRef":"x",
// "hash":"EmF4pJuw9gStEN+Mh2SjdlSg4HIJAo91oDdGUMP9PBA="}}…: expected [ Array(1) ] to deeply equal
// []" (1 failed / 1 passed); the splice was reverted and the suite went green. The second test is
// the standing positive control: every encoding is planted and required to be caught, and the
// legitimate `verifierRef` + params payload is required NOT to be caught.
//
// EVERYTHING REAL EXCEPT THE KDF: the harness pin fixture wires the production `CommandRuntime`,
// the production `setFirstPin`/`changePin`/`resetPin` orchestrators, the production client op store
// (JCS + SHA-256 + Ed25519 append), and — for the wire bytes — the production `runPushPhase`, so
// the scanned bytes are the ones the real client would send, not a hand-built approximation.
import { describe, expect, test } from 'vitest';

import {
  changePin,
  readVerifier,
  resetPin,
  runPushPhase,
  setFirstPin,
  type PinFlowDeps,
} from '@bolusi/core';
import type { ClientDatabase } from '@bolusi/db-client';

import { openPinFixture } from '../../src/pin-fixture.js';
import { ScriptedTransport, SILENT_SURFACE } from '../../src/transport.js';
import {
  leakedVerifierEncodings,
  verifierEncodings,
  type VerifierSecrets,
} from '../../src/security/verifier-scan.js';

const SEED = 2809;
const STAFF_PIN = '424242';
const OWNER_PIN = '135790';
const OWNER_NEW_PIN = '246802';
const STAFF_RESET_PIN = '975310';

describe('I-13 PIN hash material never reaches the operation log or any pushed op payload', () => {
  test('I-13 a full PIN set, change and reset cycle pushes zero bytes of any verifier salt or hash', async () => {
    const fixture = await openPinFixture(SEED, { pin: STAFF_PIN });
    try {
      const deps = fixture.flowDeps() as PinFlowDeps<ClientDatabase>;
      const secrets: VerifierSecrets[] = [];
      const capture = async (userId: string): Promise<void> => {
        const verifier = await readVerifier(fixture.db, userId);
        if (verifier === null) throw new Error(`no verifier stored for ${userId}`);
        secrets.push({ saltB64: verifier.saltB64, hashB64: verifier.hashB64 });
      };

      // The staff verifier the fixture seeded — superseded later by the reset, and therefore the
      // material an append-only log could never rotate out if it ever captured it.
      await capture(fixture.staffId);

      // The cycle, through the production command layer (each flow runs the real permission check,
      // emits the real op, and writes the real verifier).
      await setFirstPin(deps, { userId: fixture.ownerId, pin: OWNER_PIN });
      await capture(fixture.ownerId);
      await changePin(deps, {
        userId: fixture.ownerId,
        currentPin: OWNER_PIN,
        newPin: OWNER_NEW_PIN,
      });
      await capture(fixture.ownerId);
      await resetPin(deps, {
        actorUserId: fixture.ownerId,
        targetUserId: fixture.staffId,
        newPin: STAFF_RESET_PIN,
      });
      await capture(fixture.staffId);

      // ── denominators, before any "found nothing" claim (T-14b) ────────────────────────────────
      expect(secrets, 'the cycle produced fewer verifiers than it has steps').toHaveLength(4);
      expect(
        new Set(secrets.map((s) => s.saltB64)).size,
        'every set/change/reset must mint a FRESH salt (security-guide §5.2)',
      ).toBe(4);
      expect(
        new Set(secrets.map((s) => s.hashB64)).size,
        'each verifier must hash to distinct material',
      ).toBe(4);

      const authOps = await fixture.authOps();
      const pinOps = authOps.filter(
        (op) => op.type === 'auth.pin_changed' || op.type === 'auth.pin_reset',
      );
      expect(
        pinOps.length,
        'the cycle emitted no pin ops — a payload scan over nothing proves nothing',
      ).toBe(3);

      // ── the wire bytes: exactly what the PRODUCTION push phase would send ─────────────────────
      const transport = new ScriptedTransport();
      await runPushPhase({
        db: fixture.db,
        transport,
        surface: SILENT_SURFACE,
        clock: { now: () => fixture.clock.now() },
        deviceId: fixture.deviceId,
        onChainBroken: () => Promise.resolve(),
      });
      expect(transport.pushes.length, 'the push phase sent no batch').toBeGreaterThan(0);
      const pushedOps = transport.pushes.flatMap((request) => request.ops);
      expect(pushedOps.length, 'the push batch carried no ops').toBeGreaterThanOrEqual(
        pinOps.length,
      );
      expect(
        pushedOps.some((op) => op.type === 'auth.pin_reset'),
        'the pin ops never reached the wire — the scan below would be vacuous',
      ).toBe(true);

      // ── THE ASSERTION: every pushed byte, and every stored op-log payload ─────────────────────
      const wireBytes = transport.pushes.map((request) => JSON.stringify(request));
      const logBytes = authOps.map((op) => op.payload);
      for (const text of [...wireBytes, ...logBytes]) {
        expect(
          leakedVerifierEncodings(text, secrets),
          `verifier material reached the wire/op log: ${text.slice(0, 160)}…`,
        ).toEqual([]);
      }

      // The payloads DO carry the `verifierRef` — proof the scan ran over real, non-empty pin
      // payloads rather than over blanks (D11: the ref names the verifier, carrying no key bytes).
      const joined = wireBytes.join('');
      expect(joined).toContain('auth.pin_reset');
      expect(joined).toContain('verifierRef');
    } finally {
      await fixture.close();
    }
  });

  test('I-13 positive control: the scan CATCHES a planted salt and a planted hash, and ignores the params that legitimately travel', () => {
    const secrets: VerifierSecrets[] = [
      {
        saltB64: Buffer.alloc(16, 7).toString('base64'),
        hashB64: Buffer.alloc(32, 9).toString('base64'),
      },
    ];
    const encodings = verifierEncodings(secrets[0] as VerifierSecrets);
    expect(encodings.length).toBeGreaterThanOrEqual(6);

    for (const encoding of encodings) {
      const planted = JSON.stringify({ targetUserId: 'u', leaked: encoding });
      expect(
        leakedVerifierEncodings(planted, secrets),
        `the scan missed encoding ${encoding}`,
      ).toContain(encoding);
    }

    // The legitimate payload shape (api/02-auth §6.2) must NOT trip it — a scan that fires on
    // correct payloads gets routed around within a week.
    const legitimate = JSON.stringify({
      targetUserId: '0c111111-1111-7111-8111-111111111111',
      verifierRef: '0a888888-8888-7888-8888-888888888888',
      params: { algorithm: 'argon2id', mKiB: 32768, t: 3, p: 1 },
    });
    expect(leakedVerifierEncodings(legitimate, secrets)).toEqual([]);
  });
});
