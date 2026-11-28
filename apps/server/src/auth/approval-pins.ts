// Approval PINs (owner decision 2026-11-25). An owner's or manager's decision on a shared store
// device is taken only with a decision session (oplog/steps/decision.ts), which the server opens
// after checking that person's approval PIN against its own verifier. The verifier never leaves the
// server, so a copied counter PC gives away no one's approval: a sign-in PIN's verifier does live on
// shared devices, and a short PIN under a copied verifier is guessed offline in hours.
//
// Setting one needs more than a signed-in person, or whoever learned a sign-in PIN could make the
// approval PIN themselves: the current approval PIN, the person's own phone, their account
// password, or an owner's approval PIN confirming it on the spot.
import {
  DEFAULT_KDF_PARAMS,
  hashNewPin,
  utf8ToBytes,
  verifyPinAgainst,
  weakPin,
  type CryptoPort,
  type PinVerifier,
} from '@bolusi/core';
import type { TenantDb } from '@bolusi/db-server';

import { ApiError } from '../errors.js';
import { toVerifier } from '../identity/bundle.js';
import { enforce, IDENTITY_LIMITS, type WindowLimitStore } from '../identity/rate-limits.js';

/** How long a decision session proves its person: a run of decisions, and the push that carries them. */
export const DECISION_SESSION_TTL_MS = 30 * 60 * 1000;

const NO_POSITION = { timestamp: 0, deviceId: '00000000-0000-0000-0000-000000000000', seq: 0 };

/** A verifier no PIN matches, checked when there is none, so timing does not tell who has one. */
const DECOY: PinVerifier = {
  algorithm: 'argon2id',
  saltB64: Buffer.alloc(16, 9).toString('base64'),
  mKiB: DEFAULT_KDF_PARAMS.memoryCost,
  t: DEFAULT_KDF_PARAMS.timeCost,
  p: 1,
  hashB64: Buffer.alloc(32).toString('base64'),
  asOf: NO_POSITION,
};

async function verifierOf(db: TenantDb, userId: string): Promise<PinVerifier | null> {
  const row = await db
    .selectFrom('userApprovalPins')
    .select(['salt', 'params', 'hash'])
    .where('userId', '=', userId)
    .executeTakeFirst();
  if (row === undefined) return null;
  const params = (row.params ?? {}) as { m?: number; t?: number };
  return {
    algorithm: 'argon2id',
    saltB64: row.salt,
    mKiB: Number(params.m),
    t: Number(params.t),
    p: 1,
    hashB64: row.hash,
    asOf: NO_POSITION,
  };
}

/** Whether `userId` has an approval PIN. */
export async function hasApprovalPin(db: TenantDb, userId: string): Promise<boolean> {
  return (await verifierOf(db, userId)) !== null;
}

/**
 * Whether `pin` is `userId`'s approval PIN. Someone with none still costs one check, so the answer's
 * timing does not say who has one.
 */
export async function checkApprovalPin(
  db: TenantDb,
  crypto: CryptoPort,
  userId: string,
  pin: string,
): Promise<boolean> {
  const verifier = await verifierOf(db, userId);
  const matched = await verifyPinAgainst(crypto, verifier ?? DECOY, utf8ToBytes(pin));
  return verifier !== null && matched;
}

/**
 * `checkApprovalPin` under the person's guessing budget: a failure slot is reserved before the
 * check and handed back on a match, so concurrent wrong guesses cannot all pass. Throws
 * RATE_LIMITED once the budget is spent, and APPROVAL_PIN_NOT_SET when it is now the sign-in PIN.
 */
export async function approvalPinMatches(
  deps: { readonly identityRateStore: WindowLimitStore; readonly serverCrypto: CryptoPort },
  db: TenantDb,
  userId: string,
  pin: string,
  now: number,
): Promise<boolean> {
  const { limit, windowMs } = IDENTITY_LIMITS.approvalPinFailPerUser;
  const key = `approval-pin-fail:${userId}`;
  enforce(deps.identityRateStore.hit(key, limit, windowMs, now));
  const matched = await checkApprovalPin(db, deps.serverCrypto, userId, pin);
  if (!matched) return false;
  deps.identityRateStore.refund(key, windowMs, now);
  // A sign-in PIN changed later to the same digits gives this one away with its verifier on shared
  // devices, so it counts as none: the person sets a new one.
  if (await sameAsSignIn(db, deps.serverCrypto, userId, pin)) {
    throw new ApiError('APPROVAL_PIN_NOT_SET', { sameAsSignIn: true });
  }
  return true;
}

async function sameAsSignIn(
  db: TenantDb,
  crypto: CryptoPort,
  userId: string,
  pin: string,
): Promise<boolean> {
  const signIn = await db
    .selectFrom('userPinVerifiers')
    .select(['salt', 'params', 'hash', 'asOfTimestamp', 'asOfDeviceId', 'asOfSeq'])
    .where('userId', '=', userId)
    .executeTakeFirst();
  return signIn !== undefined && verifyPinAgainst(crypto, toVerifier(signIn), utf8ToBytes(pin));
}

/**
 * Refuse an approval PIN that protects nothing: one easy to guess, or the person's sign-in PIN,
 * whose verifier sits on shared devices and so would give this one away with it.
 */
export async function requireUsableApprovalPin(
  db: TenantDb,
  crypto: CryptoPort,
  userId: string,
  pin: string,
): Promise<void> {
  if (weakPin(pin)) throw new ApiError('APPROVAL_PIN_WEAK');
  if (await sameAsSignIn(db, crypto, userId, pin)) {
    throw new ApiError('APPROVAL_PIN_WEAK', { sameAsSignIn: true });
  }
}

/** Store `pin` as `userId`'s approval PIN, with a fresh salt, replacing any earlier one. */
export async function storeApprovalPin(
  db: TenantDb,
  crypto: CryptoPort,
  params: {
    tenantId: string;
    userId: string;
    pin: string;
    setBy: string;
    now: number;
    salt: Uint8Array;
  },
): Promise<void> {
  const material = await hashNewPin(
    crypto,
    utf8ToBytes(params.pin),
    DEFAULT_KDF_PARAMS,
    params.salt,
  );
  const values = {
    salt: material.saltB64,
    params: { m: material.mKiB, t: material.t, p: material.p } as never,
    hash: material.hashB64,
    setAt: BigInt(params.now),
    setBy: params.setBy,
  };
  await db
    .insertInto('userApprovalPins')
    .values({ userId: params.userId, tenantId: params.tenantId, ...values })
    .onConflict((oc) => oc.column('userId').doUpdateSet(values))
    .execute();
}

/** Remove `userId`'s approval PIN: they set a new one the way they set the first. */
export async function clearApprovalPin(db: TenantDb, userId: string): Promise<void> {
  await db.deleteFrom('userApprovalPins').where('userId', '=', userId).execute();
}
