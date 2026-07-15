// Control-session lifecycle (api/02-auth §4.2, §8): a `bcs_` token minted at login, 10-minute
// TTL, bound to one user, stored HASHED at rest (SHA-256), valid only for the §4.5 control-plane
// column. It exists so enrollment and emergency revocation need no enrolled device, and expires
// before it becomes ambient authority.
import type { TenantDb } from '@bolusi/db-server';

import { mintToken, sha256Hex } from '../crypto/index.js';
import { uuidv7 } from '../uuidv7.js';

/** 10-minute TTL (api/02-auth §4.2, §8). */
export const CONTROL_SESSION_TTL_MS = 10 * 60 * 1000;

export interface MintedControlSession {
  /** The plaintext `bcs_` token — returned once to the client; only its hash is stored. */
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: number;
}

/** Mint + persist (hash-only) a control session for `userId`, inside the caller's forTenant tx. */
export async function mintControlSession(
  db: TenantDb,
  params: { tenantId: string; userId: string; now: number },
): Promise<MintedControlSession> {
  const token = mintToken('bcs_');
  const sessionId = uuidv7(params.now);
  const expiresAt = params.now + CONTROL_SESSION_TTL_MS;

  await db
    .insertInto('controlSessions')
    .values({
      id: sessionId,
      tenantId: params.tenantId,
      userId: params.userId,
      tokenHash: sha256Hex(token), // never the plaintext (api/02-auth §8)
      createdAt: BigInt(params.now),
      expiresAt: BigInt(expiresAt),
    })
    .execute();

  return { token, sessionId, expiresAt };
}
