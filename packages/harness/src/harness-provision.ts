// Shared harness provisioning for the production-auth path (task 201-B) — the ONE home for the two
// operations every production-auth consumer repeats (§2.8, the rule-of-three that fired once the lane
// serve entry became the third caller):
//   • provisionHarnessOwner — run the REAL `provisionTenant` CLI transaction (the same single tx
//     production provisioning runs, re-exported via `@bolusi/server/test-support`) through a harness
//     server's RLS-scoped `forTenant` + `FakeClock`, optionally with a DETERMINISTIC one-time password
//     (the provision seam; argon2id `createPasswordVerifier` left untouched);
//   • seedOwnerPin — write a user's PIN verifier row with REAL argon2id (`buildPinVerifier`), the exact
//     `userPinVerifiers` shape `users.ts writeVerifier` writes, so the self-describing verifier travels
//     in the enroll bundle and verifies on-device.
//
// PURE PROVISIONING ONLY — no socket, no ready-marker, no lane-serve orchestration (that lives in
// `serve-lane.ts`). Kept separate so the pivotal §2.5 de-risk (`pglite-production-auth.test.ts`) depends
// only on the provisioning it actually exercises, never on serve/marker code whose breakage would
// falsely red the security-evidence proof.
import { buildPinVerifier, DEFAULT_KDF_PARAMS, type CanonicalRef } from '@bolusi/core';
import {
  defaultProvisionDeps,
  provisionTenant,
  type ProvisionResult,
} from '@bolusi/server/test-support';
import { noblePort, type FakeClock } from '@bolusi/test-support';

import type { HarnessForTenant } from './server.js';

/**
 * The minimal harness-server surface provisioning needs: the RLS-scoped tenant transaction and the
 * clock. Structural, so both {@link HarnessServer} and the de-risk test's in-process server satisfy it
 * without importing the concrete class — and, crucially, without ever exposing a raw unscoped handle.
 */
export interface ProvisionableServer {
  readonly forTenant: HarnessForTenant;
  readonly clock: FakeClock;
}

// The canonical lane owner identity + deterministic credentials the pending Maestro flows type as
// literals. English internal names live here (07-i18n: localized strings only via the label catalog);
// these are the tenant/store/owner DISPLAY names the provision CLI persists, matching the de-risk oracle.
export const LANE_OWNER_LOGIN = 'gudang-selatan';
export const LANE_TENANT_NAME = 'Gudang Selatan';
export const LANE_STORE_NAME = 'Toko Utama';
export const LANE_OWNER_NAME = 'Pemilik';
// A deterministic one-time password the Maestro enroll flow types. Carries the `password` stopword so
// the gitleaks generic-api-key rule does not flag this fixed, non-secret test literal.
export const LANE_OTP = 'harness-otp-password-201b';
// A deterministic 6-digit PIN (PinPad.tsx PIN_LENGTH=6) the Maestro PIN flow types. Digits only ⇒ below
// the gitleaks entropy threshold; the first six digits of π so a reader sees intent, not a secret.
export const LANE_PIN = '314159';

/**
 * Provision one tenant + owner through the REAL `provisionTenant` transaction over a harness server.
 *
 * Overrides only the three seams every consumer overrides — `forTenant` (the PGlite handle), `now` (the
 * FakeClock), and, when `oneTimePassword` is given, `generatePassword` (the deterministic provision
 * seam) — and defaults everything else from `defaultProvisionDeps` (real argon2id `createPasswordVerifier`,
 * real `generateSystemKeypair`). Omit `oneTimePassword` to keep the default random password (read it back
 * off `result.oneTimePassword`).
 */
export async function provisionHarnessOwner(
  server: ProvisionableServer,
  options?: { readonly oneTimePassword?: string },
): Promise<ProvisionResult> {
  // Capture into a const so TS narrows it to `string` inside the deferred `generatePassword` closure.
  const oneTimePassword = options?.oneTimePassword;
  return provisionTenant(
    {
      ...defaultProvisionDeps,
      forTenant: server.forTenant,
      now: () => server.clock.now(),
      ...(oneTimePassword === undefined ? {} : { generatePassword: () => oneTimePassword }),
    },
    {
      tenantName: LANE_TENANT_NAME,
      storeNames: [LANE_STORE_NAME],
      ownerName: LANE_OWNER_NAME,
      ownerLogin: LANE_OWNER_LOGIN,
    },
  );
}

/**
 * Seed a user's PIN verifier with REAL argon2id — the exact `userPinVerifiers` row shape `users.ts`
 * `writeVerifier` writes (params jsonb as `{ m, t, p }`), through the tenant-scoped `forTenant` path.
 * The verifier is self-describing (its argon2id params travel with it), so it verifies on-device iff
 * both sides run standard argon2id.
 */
export async function seedOwnerPin(
  server: ProvisionableServer,
  args: {
    readonly tenantId: string;
    readonly userId: string;
    readonly asOfDeviceId: string;
    readonly pin: string;
  },
): Promise<void> {
  const pinBytes = new TextEncoder().encode(args.pin);
  const salt = noblePort.randomBytes(16);
  const asOf: CanonicalRef = {
    timestamp: server.clock.now(),
    deviceId: args.asOfDeviceId,
    seq: 0,
  };
  const verifier = await buildPinVerifier(noblePort, pinBytes, DEFAULT_KDF_PARAMS, salt, asOf);
  await server.forTenant(args.tenantId, (trx) =>
    trx
      .insertInto('userPinVerifiers')
      .values({
        userId: args.userId,
        tenantId: args.tenantId,
        algo: 'argon2id',
        salt: verifier.saltB64,
        params: { m: verifier.mKiB, t: verifier.t, p: verifier.p } as never,
        hash: verifier.hashB64,
        asOfTimestamp: BigInt(verifier.asOf.timestamp),
        asOfDeviceId: verifier.asOf.deviceId,
        asOfSeq: BigInt(verifier.asOf.seq),
      })
      .execute(),
  );
}
