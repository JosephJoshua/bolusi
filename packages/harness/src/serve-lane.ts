// The production-auth emulator lane's serve support (task 201-B, subtask d) — the testable core behind
// the thin `scripts/harness-serve-lane.mjs` entry (a root .mjs cannot resolve bare `@bolusi/*`
// specifiers, so all logic lives here in harness src and is re-exported from the barrel the .mjs imports
// via `dist/`). Two concerns:
//   • provisionLaneOwner — stand a lane-ready owner in a booted production-auth server: provision with
//     the deterministic LANE_OTP, then seed the owner's LANE_PIN verifier so it travels in the enroll
//     bundle. Returns the credentials the Maestro flows type as literals.
//   • the ready marker — a single, round-trippable stdout line the lane driver waits on before
//     `adb reverse` + `maestro`, carrying the bound loopback port and the provisioned credentials.
import type { ProvisionResult } from '@bolusi/server/test-support';

import {
  LANE_OTP,
  LANE_OWNER_LOGIN,
  LANE_PIN,
  provisionHarnessOwner,
  seedOwnerPin,
  type ProvisionableServer,
} from './harness-provision.js';

/**
 * The fixed port the emulator lane binds — matches the APK's `EXPO_PUBLIC_API_URL` (`10.0.2.2:3000`
 * aliases host loopback `127.0.0.1:3000`, reached via `adb reverse tcp:3000 tcp:3000`). Tests pass `0`
 * for an ephemeral port so parallel servers never collide.
 */
export const LANE_PORT = 3000;

/** The stdout token the serve entry prints ONCE the server is listening + provisioned. */
export const LANE_READY_MARKER = 'BOLUSI_LANE_READY';

/** The lane owner's credentials — the literals the pending Maestro flows type to enroll + unlock. */
export interface LaneCredentials {
  readonly ownerLogin: string;
  readonly oneTimePassword: string;
  readonly pin: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly ownerUserId: string;
}

/**
 * Provision the lane owner in a booted production-auth server: the REAL `provisionTenant` transaction
 * with the deterministic {@link LANE_OTP}, then seed the owner's {@link LANE_PIN} verifier (real
 * argon2id) so the enroll bundle carries it. The server MUST have been booted with `productionAuth`
 * (so login resolves via the D14 definer path) — this only provisions; it does not boot or listen.
 */
export async function provisionLaneOwner(server: ProvisionableServer): Promise<LaneCredentials> {
  const provisioned: ProvisionResult = await provisionHarnessOwner(server, {
    oneTimePassword: LANE_OTP,
  });
  await seedOwnerPin(server, {
    tenantId: provisioned.tenantId,
    userId: provisioned.ownerUserId,
    asOfDeviceId: provisioned.systemDeviceId,
    pin: LANE_PIN,
  });
  // We provision exactly one store (LANE_STORE_NAME), so storeIds[0] is always present; assert it
  // loudly rather than silently ship an `undefined` storeId the Maestro enroll flow would fail on.
  const [storeId] = provisioned.storeIds;
  if (storeId === undefined) {
    throw new Error('provisionLaneOwner: provisionTenant returned no store');
  }
  return {
    ownerLogin: LANE_OWNER_LOGIN,
    oneTimePassword: LANE_OTP,
    pin: LANE_PIN,
    tenantId: provisioned.tenantId,
    storeId,
    ownerUserId: provisioned.ownerUserId,
  };
}

/** The ready-marker payload: where the server bound + the credentials to enroll against it. */
export interface LaneReady {
  readonly url: string;
  readonly address: string;
  readonly port: number;
  readonly credentials: LaneCredentials;
}

/**
 * Render the ready marker as ONE stdout line (`BOLUSI_LANE_READY: {json}`). The payload is
 * `JSON.stringify` output — no leading/trailing space, no embedded newline (every field is a clean
 * string/number) — so {@link parseLaneReady} round-trips it byte-for-byte.
 */
export function formatLaneReady(ready: LaneReady): string {
  return `${LANE_READY_MARKER}: ${JSON.stringify(ready)}`;
}

/**
 * Parse a ready marker back out of a stdout line, or `undefined` if the line is not a marker. Trims
 * first (so a trailing newline from `console.log` or surrounding whitespace does not defeat the match),
 * then requires the exact `BOLUSI_LANE_READY: ` prefix.
 */
export function parseLaneReady(line: string): LaneReady | undefined {
  const trimmed = line.trim();
  const prefix = `${LANE_READY_MARKER}: `;
  if (!trimmed.startsWith(prefix)) return undefined;
  return JSON.parse(trimmed.slice(prefix.length)) as LaneReady;
}
