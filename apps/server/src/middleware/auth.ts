// Bearer authentication (api/00 §3, §13 step 6). The bearer slot carries one of two token
// kinds by prefix — `bdt_` device tokens, `bcs_` control-session tokens. `verifyToken` hashes
// the presented token, looks up its record by hash (a DB dump yields no usable tokens —
// SEC-DEV-02), constant-time-confirms the match, and sets the request principal (§3).
//
// DEVIATION (flagged): api/00 §3/§13 name `bearerAuth` from `hono/bearer-auth`. The built-in
// cannot serve this contract — it maps an unparseable header to 400 (§7 requires 401
// AUTH_TOKEN_MISSING), it has no third outcome for DEVICE_REVOKED, and it returns a boolean
// rather than setting typed `device`/`controlSession` context. This middleware keeps the exact
// `bearerAuth({ verifyToken })` shape and semantics while emitting the three §7 codes and
// setting context. The token store is injected — the real DB-backed store lands in task 13.
import { createHash, timingSafeEqual } from 'node:crypto';

import type { MiddlewareHandler } from 'hono';

import { ApiError } from '../errors.js';
import type { AppEnv, ControlPrincipal, DevicePrincipal } from '../env.js';

export const DEVICE_TOKEN_PREFIX = 'bdt_';
export const CONTROL_TOKEN_PREFIX = 'bcs_';

/** A stored token record, keyed at rest by the token's SHA-256 hash (SEC-DEV-02). */
export type TokenRecord =
  | {
      readonly kind: 'device';
      /** SHA-256 of the issued token — the only token material stored (never the plaintext). */
      readonly tokenHash: Uint8Array;
      readonly deviceId: string;
      readonly tenantId: string;
      readonly storeId: string | null;
      /** Device.status (03-state-machines §5). A revoked device authenticates to DEVICE_REVOKED. */
      readonly deviceStatus: 'active' | 'revoked';
    }
  | {
      readonly kind: 'control';
      readonly tokenHash: Uint8Array;
      readonly userId: string;
      readonly tenantId: string;
      /** ms-epoch expiry; a session at/after this is AUTH_TOKEN_INVALID. */
      readonly expiresAt: number;
    };

/**
 * Looks a token record up by its SHA-256 hash (hex). The real store (task 13, api/02-auth)
 * queries the devices / control-session tables; v0 skeleton ships an in-memory impl for tests
 * and an empty default.
 */
export interface TokenStore {
  findByTokenHash(tokenHashHex: string): Promise<TokenRecord | undefined>;
}

/** An empty store — no token authenticates. Default until task 13 wires the DB-backed store. */
export const emptyTokenStore: TokenStore = {
  findByTokenHash: async () => undefined,
};

/** In-memory store for tests: register records by their plaintext token. */
export class InMemoryTokenStore implements TokenStore {
  readonly #byHash = new Map<string, TokenRecord>();

  add(
    token: string,
    record:
      | Omit<Extract<TokenRecord, { kind: 'device' }>, 'tokenHash'>
      | Omit<Extract<TokenRecord, { kind: 'control' }>, 'tokenHash'>,
  ): void {
    const hash = sha256(token);
    this.#byHash.set(toHex(hash), { ...record, tokenHash: hash } as TokenRecord);
  }

  findByTokenHash(tokenHashHex: string): Promise<TokenRecord | undefined> {
    return Promise.resolve(this.#byHash.get(tokenHashHex));
  }
}

function sha256(input: string): Uint8Array {
  return createHash('sha256').update(input, 'utf8').digest();
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

// RFC 6750 token68 charset — matches hono/bearer-auth's own parser so a malformed header is
// rejected identically (but as AUTH_TOKEN_MISSING per §7, not the built-in's 400).
const BEARER = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/;

/** Parse `Authorization: Bearer <token>`. Returns null on a missing/unparseable header. */
export function parseBearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = BEARER.exec(header);
  return match ? (match[1] ?? null) : null;
}

export type VerifyToken = (
  token: string,
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
) => Promise<void>;

/**
 * Builds the `verifyToken` used by the bearer middleware. On success it sets `device` or
 * `controlSession` context; otherwise it throws the appropriate §7 code.
 */
export function createVerifyToken(deps: { store: TokenStore; now: () => number }): VerifyToken {
  return async (token, c) => {
    const presented = sha256(token);
    const record = await deps.store.findByTokenHash(toHex(presented));
    // Unknown token → invalid. Constant-time confirm the stored hash matches the presented one
    // (api/00 §3: constant-time comparison) — the hash-at-rest lookup is the real defense, this
    // is the named gate a byte-comparison timing attack would target.
    if (record === undefined || !constantTimeEqual(presented, record.tokenHash)) {
      throw new ApiError('AUTH_TOKEN_INVALID');
    }
    if (record.kind === 'device') {
      if (record.deviceStatus === 'revoked') {
        throw new ApiError('DEVICE_REVOKED');
      }
      const principal: DevicePrincipal = {
        deviceId: record.deviceId,
        tenantId: record.tenantId,
        storeId: record.storeId,
      };
      c.set('device', principal);
      return;
    }
    if (record.expiresAt <= deps.now()) {
      throw new ApiError('AUTH_TOKEN_INVALID');
    }
    const principal: ControlPrincipal = { userId: record.userId, tenantId: record.tenantId };
    c.set('controlSession', principal);
  };
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * `bearerAuth({ verifyToken })` (api/00 §3). Missing/unparseable header → AUTH_TOKEN_MISSING;
 * verifyToken resolves (context set) or throws AUTH_TOKEN_INVALID / DEVICE_REVOKED. The
 * Authorization value is never logged (access-log strips it — §13 step 3).
 */
export function bearerAuth(options: { verifyToken: VerifyToken }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = parseBearer(c.req.header('Authorization'));
    if (token === null) {
      throw new ApiError('AUTH_TOKEN_MISSING');
    }
    await options.verifyToken(token, c);
    await next();
  };
}
