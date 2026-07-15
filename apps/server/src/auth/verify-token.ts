// The DB-backed `verifyToken` for task 12's `bearerAuth` slot (api/00 §3, api/02-auth §8).
//
// Task 12 shipped the seam: `bearerAuth({ verifyToken })`, the `TokenStore` interface, and
// `createVerifyToken({ store, now })` (which hashes the presented token, looks it up, does the
// constant-time confirm, checks device-revoked / session-expiry, and sets device/controlSession
// context). Its default store is empty. This module supplies the REAL store: a `bdt_`/`bcs_`
// hash-then-lookup against `devices`/`control_sessions` through the AuthDirectory (D14). A DB dump
// yields no usable tokens — the lookup key is the SHA-256 hash, never the plaintext (SEC-DEV-02).
import type { AuthDirectory } from './directory.js';
import {
  createVerifyToken,
  type TokenRecord,
  type TokenStore,
  type VerifyToken,
} from '../middleware/auth.js';

/**
 * A `TokenStore` backed by the AuthDirectory. `findByTokenHash` receives the SHA-256 hex of the
 * presented token (task 12 hashes it), tries the device table first, then control sessions.
 * A revoked control session is treated as absent (there is no v0 endpoint that presents one, but
 * fail closed on the column regardless).
 */
export function createDbTokenStore(directory: AuthDirectory): TokenStore {
  return {
    async findByTokenHash(tokenHashHex: string): Promise<TokenRecord | undefined> {
      // The lookup already matched by hash equality in SQL; carry the same bytes back so task
      // 12's constant-time confirm (`timingSafeEqual(presented, record.tokenHash)`) is a no-op
      // match rather than a spurious mismatch.
      const tokenHash = Buffer.from(tokenHashHex, 'hex');

      const device = await directory.findDeviceByTokenHash(tokenHashHex);
      if (device !== undefined) {
        return {
          kind: 'device',
          tokenHash,
          deviceId: device.deviceId,
          tenantId: device.tenantId,
          storeId: device.storeId,
          deviceStatus: device.status === 'revoked' ? 'revoked' : 'active',
        };
      }

      const session = await directory.findControlSessionByTokenHash(tokenHashHex);
      if (session !== undefined && session.revokedAt === null) {
        return {
          kind: 'control',
          tokenHash,
          userId: session.userId,
          tenantId: session.tenantId,
          expiresAt: session.expiresAt,
        };
      }

      return undefined;
    },
  };
}

/** Build the `verifyToken` used in the bearerAuth slot from an AuthDirectory + clock. */
export function createDbVerifyToken(directory: AuthDirectory, now: () => number): VerifyToken {
  return createVerifyToken({ store: createDbTokenStore(directory), now });
}
