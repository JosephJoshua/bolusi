// SEC-AUTH-06 (PIN reset authorization, client arm) + SEC-AUTH-11 (privileged-target, client arm) +
// the PIN set/change/reset flows + the verifier-POST queue. The forged-op push rejection
// (SCOPE_VIOLATION) is the SERVER arm — tasks 13/16 — cross-referenced here, never implemented.
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';

import {
  changePin,
  changePinCommand,
  clearPinLockoutFlow,
  createLockedOutEmitter,
  DomainError,
  drainPendingVerifiers,
  readPendingVerifiers,
  readVerifier,
  resetPin,
  setFirstPin,
  writeMeta,
  FIRST_PIN_USER_META_KEY,
  firstPinUserOnThisDevice,
  verifyPin,
  writePinAttempt,
  type PinFlowDeps,
  type PinVerifierUploadPort,
} from '../../src/index.js';
import type { ClientDatabase } from '@bolusi/db-client';
import type { Kysely } from 'kysely';
import type { SignedCore } from '@bolusi/schemas';

import { makeFastCrypto, openAuthHarness, spyKdf, type AuthHarness } from './_harness.js';

let harness: AuthHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

interface Setup {
  readonly h: AuthHarness;
  flowDeps(): PinFlowDeps<ClientDatabase>;
  pinOps(): Promise<
    {
      type: string;
      userId: string;
      entityId: string;
      seq: number;
      timestamp: number;
      deviceId: string;
      payload: string;
    }[]
  >;
}

async function setup(
  seed: number,
  verifiers?: { owner?: string; storeOwner?: string; staff?: string },
): Promise<Setup> {
  const h = await openAuthHarness(seed, {
    crypto: spyKdf(makeFastCrypto()).crypto,
    ...(verifiers ? { verifiers } : {}),
  });
  harness = h;
  const emitter = createLockedOutEmitter(h.runtime);
  return {
    h,
    flowDeps: () => ({
      runtime: h.runtime,
      db: h.db,
      crypto: h.crypto,
      clock: h.clock,
      idSource: h.idSource,
      deviceId: h.deviceId,
      emitter,
    }),
    pinOps: async () => {
      const rows = await h.db
        .selectFrom('operations')
        .select(['type', 'userId', 'entityId', 'seq', 'timestampMs', 'deviceId', 'signedCoreJcs'])
        .where('type', 'in', [
          'auth.pin_changed',
          'auth.pin_reset',
          'auth.pin_lockout_cleared',
          'auth.permission_denied',
        ])
        .orderBy('seq')
        .execute();
      return rows.map((r) => ({
        type: r.type,
        userId: r.userId,
        entityId: r.entityId,
        seq: r.seq,
        timestamp: r.timestampMs,
        deviceId: r.deviceId,
        payload: JSON.stringify((JSON.parse(r.signedCoreJcs) as SignedCore).payload),
      }));
    },
  };
}

async function expectDomain(
  p: Promise<unknown>,
  code: string,
  reason?: string,
): Promise<DomainError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError && e.code === code) {
      if (reason !== undefined) expect(e.details).toMatchObject({ reason });
      return e;
    }
    throw new Error(`expected DomainError(${code}), got ${String(e)}`);
  }
  throw new Error(`expected DomainError(${code}), nothing thrown`);
}

describe('SEC-AUTH-06 client arm — PIN command permission/targeting denials', () => {
  it('auth.changePin targeting non-self → PERMISSION_DENIED restriction_violated, AUDITED (§5.4.6, §7)', async () => {
    const s = await setup(1);
    const err = await expectDomain(
      s.h.runtime.execute(
        changePinCommand,
        { targetUserId: s.h.ownerId, verifierRef: s.h.idSource() },
        s.h.runtime.createContext(s.h.staffId),
      ),
      'PERMISSION_DENIED',
      'restriction_violated',
    );
    expect(err.details).toMatchObject({ reason: 'restriction_violated' });
    // The pure handler DECLARED the restriction (it cannot emit); the runtime EMITTED the denial op
    // through the same enforcement point an evaluator denial uses (02 §7 amended "Emitted by").
    const all = await s.pinOps();
    expect(
      all.filter((o) => o.type === 'auth.pin_changed'),
      'no business op appended',
    ).toHaveLength(0);
    const denials = all.filter((o) => o.type === 'auth.permission_denied');
    expect(denials, 'exactly one denial op — the WHOLE set, not a sample (T-14)').toHaveLength(1);
    expect(denials[0]!.userId, 'attributed to the denied actor').toBe(s.h.staffId);
    expect(JSON.parse(denials[0]!.payload)).toEqual({
      permissionId: 'auth.pin_change',
      surface: 'command',
      target: 'changePin',
      reason: 'restriction_violated',
      scopeStoreId: s.h.storeId,
      suppressedRepeats: 0,
    });
  });

  it('auth.resetPin without auth.user_reset_pin → PERMISSION_DENIED + auth.permission_denied emitted', async () => {
    const s = await setup(2);
    // staff lacks auth.user_reset_pin. Target (storeOwner) is a valid, non-main-owner directory user.
    await expectDomain(
      resetPin(s.flowDeps(), {
        actorUserId: s.h.staffId,
        targetUserId: s.h.storeOwnerId,
        newPin: '593026',
      }),
      'PERMISSION_DENIED',
    );
    const denials = (await s.pinOps()).filter((o) => o.type === 'auth.permission_denied');
    expect(denials, 'the denial is logged (02 §7)').toHaveLength(1);
    expect(denials[0]!.userId).toBe(s.h.staffId);
    expect((await s.pinOps()).filter((o) => o.type === 'auth.pin_reset')).toHaveLength(0);
    expect(await readPendingVerifiers(s.h.db), 'a refused reset queues no upload').toEqual([]);
  });

  it('reset target absent from users_directory → denied restriction_violated, AUDITED (§5.4.6, §7)', async () => {
    const s = await setup(3);
    await expectDomain(
      resetPin(s.flowDeps(), {
        actorUserId: s.h.ownerId,
        targetUserId: 'b2222222-2222-7222-8222-222222222222',
        newPin: '593026',
      }),
      'PERMISSION_DENIED',
      'restriction_violated',
    );
    // The lossy bug this task closes: the restriction denied, and the audit records it (was: no op).
    const all = await s.pinOps();
    expect(
      all.filter((o) => o.type === 'auth.pin_reset'),
      'no business op',
    ).toHaveLength(0);
    const denials = all.filter((o) => o.type === 'auth.permission_denied');
    expect(denials, 'exactly one denial op — the WHOLE set (T-14)').toHaveLength(1);
    expect(denials[0]!.userId).toBe(s.h.ownerId);
    expect(JSON.parse(denials[0]!.payload)).toEqual({
      permissionId: 'auth.user_reset_pin',
      surface: 'command',
      target: 'resetPin',
      reason: 'restriction_violated',
      scopeStoreId: s.h.storeId,
      suppressedRepeats: 0,
    });
  });

  it('auth.clearPinLockout without auth.pin_unlock → denied (+ evaluator denial op, reason not_granted)', async () => {
    const s = await setup(4);
    // Lock the store owner directly, then a staff member (no pin_unlock) tries to clear it.
    await writePinAttempt(s.h.db, {
      userId: s.h.storeOwnerId,
      deviceId: s.h.deviceId,
      consecutiveFailures: 10,
      windowStartedAt: 1,
      notBefore: null,
    });
    await expectDomain(
      clearPinLockoutFlow(s.flowDeps(), {
        actorUserId: s.h.staffId,
        targetUserId: s.h.storeOwnerId,
      }),
      'PERMISSION_DENIED',
    );
    const all = await s.pinOps();
    expect(
      all.filter((o) => o.type === 'auth.pin_lockout_cleared'),
      'no business op',
    ).toHaveLength(0);
    // POSITIVE CONTROL / distinct-reason: the EVALUATOR denial (staff lacks the permission) has
    // always been logged — reason `not_granted`, distinct from a `restriction_violated` denial.
    const denials = all.filter((o) => o.type === 'auth.permission_denied');
    expect(denials, 'exactly one denial op').toHaveLength(1);
    expect(JSON.parse(denials[0]!.payload)).toMatchObject({
      permissionId: 'auth.pin_unlock',
      target: 'clearPinLockout',
      reason: 'not_granted',
    });
  });

  it('clearPinLockout target absent from users_directory → restriction_violated, AUDITED (§5.4.6, §7)', async () => {
    const s = await setup(12);
    // Owner HOLDS auth.pin_unlock, so the denial is the DIRECTORY restriction, not a permission gap
    // — the fourth restriction call site, which nobody had enumerated a test for (T-12 sweep).
    await expectDomain(
      clearPinLockoutFlow(s.flowDeps(), {
        actorUserId: s.h.ownerId,
        targetUserId: 'b2222222-2222-7222-8222-222222222222',
      }),
      'PERMISSION_DENIED',
      'restriction_violated',
    );
    const all = await s.pinOps();
    expect(
      all.filter((o) => o.type === 'auth.pin_lockout_cleared'),
      'no business op',
    ).toHaveLength(0);
    const denials = all.filter((o) => o.type === 'auth.permission_denied');
    expect(denials, 'exactly one denial op — the WHOLE set (T-14)').toHaveLength(1);
    expect(denials[0]!.userId).toBe(s.h.ownerId);
    expect(JSON.parse(denials[0]!.payload)).toEqual({
      permissionId: 'auth.pin_unlock',
      surface: 'command',
      target: 'clearPinLockout',
      reason: 'restriction_violated',
      scopeStoreId: s.h.storeId,
      suppressedRepeats: 0,
    });
  });
});

describe('SEC-AUTH-11 client arm — privileged-target PIN reset (api/02-auth §6.6)', () => {
  it('store_owner resetting a main_owner-role holder → denied at the command layer, AUDITED (§7)', async () => {
    const s = await setup(5);
    // storeOwner HOLDS auth.user_reset_pin, but the target (owner) holds main_owner and the actor does
    // not → the privileged-target rule denies BEFORE the command's permission check.
    await expectDomain(
      resetPin(s.flowDeps(), {
        actorUserId: s.h.storeOwnerId,
        targetUserId: s.h.ownerId,
        newPin: '593026',
      }),
      'PERMISSION_DENIED',
      'restriction_violated',
    );
    const all = await s.pinOps();
    expect(
      all.filter((o) => o.type === 'auth.pin_reset'),
      'no business op',
    ).toHaveLength(0);
    // The audit is weakest exactly where the attack is worst — this is the case that MUST be logged
    // (task 28's privileged-target matrix reads it back). It now is.
    const denials = all.filter((o) => o.type === 'auth.permission_denied');
    expect(denials, 'exactly one denial op — the WHOLE set (T-14)').toHaveLength(1);
    expect(denials[0]!.userId, 'attributed to the denied store_owner').toBe(s.h.storeOwnerId);
    expect(JSON.parse(denials[0]!.payload)).toEqual({
      permissionId: 'auth.user_reset_pin',
      surface: 'command',
      target: 'resetPin',
      reason: 'restriction_violated',
      scopeStoreId: s.h.storeId,
      suppressedRepeats: 0,
    });
    // (Forged-op push → SCOPE_VIOLATION is the server arm, tasks 13/16 — not implemented here.)
  });

  it('main_owner actor resetting the same main_owner-role target → allowed + audited', async () => {
    const s = await setup(6);
    await resetPin(s.flowDeps(), {
      actorUserId: s.h.ownerId,
      targetUserId: s.h.ownerId,
      newPin: '593026',
    });
    const resets = (await s.pinOps()).filter((o) => o.type === 'auth.pin_reset');
    expect(resets).toHaveLength(1);
    expect(resets[0]!.userId, 'attributed to the acting main owner').toBe(s.h.ownerId);
    expect(resets[0]!.entityId).toBe(s.h.ownerId);
  });
});

describe('PIN flows (api/02-auth §6.6) — verifier-free payloads, asOf, fresh salt', () => {
  it('a PIN anyone would guess is refused by every flow that makes one, whatever the screen did', async () => {
    const s = await setup(7);
    await enrolledBy(s, s.h.staffId);
    await expect(
      setFirstPin(s.flowDeps(), { userId: s.h.staffId, pin: '111111' }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { field: 'pin', issue: 'weak' },
    });
    expect(await readVerifier(s.h.db, s.h.staffId)).toBeNull();
    await setFirstPin(s.flowDeps(), { userId: s.h.staffId, pin: '274816' });
    await expect(
      changePin(s.flowDeps(), { userId: s.h.staffId, currentPin: '274816', newPin: '123456' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('first-PIN: forced setup, current-PIN check skipped, local write at the op asOf, fresh salt', async () => {
    const s = await setup(7); // staff has NO verifier by default → first-PIN territory
    await enrolledBy(s, s.h.staffId);
    const pending = await setFirstPin(s.flowDeps(), { userId: s.h.staffId, pin: '274816' });

    const [op] = (await s.pinOps()).filter((o) => o.type === 'auth.pin_changed');
    expect(op).toBeDefined();
    expect(op!.entityId).toBe(s.h.staffId);
    expect(JSON.parse(op!.payload)).toEqual({
      targetUserId: s.h.staffId,
      verifierRef: pending.verifierRef,
    });

    // The local verifier's asOf equals the emitting op's canonical position (§5.3).
    const stored = await readVerifier(s.h.db, s.h.staffId);
    expect(stored?.asOf).toEqual({
      timestamp: op!.timestamp,
      deviceId: op!.deviceId,
      seq: op!.seq,
    });
    expect(new Uint8Array(atobLen(stored!.saltB64))).toHaveLength(16);

    // Now the first PIN verifies.
    const emitter = createLockedOutEmitter(s.h.runtime);
    expect(
      (
        await verifyPin(
          { db: s.h.db, crypto: s.h.crypto, clock: s.h.clock, deviceId: s.h.deviceId, emitter },
          { userId: s.h.staffId, pin: '274816' },
        )
      ).ok,
    ).toBe(true);
  });

  it('first-PIN: refused for a user who already has a PIN, so it cannot overwrite one', async () => {
    const s = await setup(7, { staff: '482915' });
    await enrolledBy(s, s.h.staffId);
    await expectDomain(
      setFirstPin(s.flowDeps(), { userId: s.h.staffId, pin: '274816' }),
      'INVALID_TRANSITION',
    );
    expect((await s.pinOps()).filter((o) => o.type === 'auth.pin_changed')).toHaveLength(0);
  });

  it('change: the current PIN is verified before execution; a wrong current PIN is refused', async () => {
    const s = await setup(8, { staff: '482915' });
    // Wrong current PIN → NOT_AUTHENTICATED, no new verifier, no op.
    await expectDomain(
      changePin(s.flowDeps(), { userId: s.h.staffId, currentPin: '805139', newPin: '593026' }),
      'NOT_AUTHENTICATED',
    );
    expect((await s.pinOps()).filter((o) => o.type === 'auth.pin_changed')).toHaveLength(0);

    // Correct current PIN → change succeeds; new PIN verifies, old does not; salt is fresh.
    const before = await readVerifier(s.h.db, s.h.staffId);
    await changePin(s.flowDeps(), { userId: s.h.staffId, currentPin: '482915', newPin: '593026' });
    const after = await readVerifier(s.h.db, s.h.staffId);
    expect(after?.saltB64).not.toBe(before?.saltB64); // NEW salt on every change (SEC-AUTH-06)

    const emitter = createLockedOutEmitter(s.h.runtime);
    const deps = {
      db: s.h.db,
      crypto: s.h.crypto,
      clock: s.h.clock,
      deviceId: s.h.deviceId,
      emitter,
    };
    expect((await verifyPin(deps, { userId: s.h.staffId, pin: '593026' })).ok).toBe(true);
    expect((await verifyPin(deps, { userId: s.h.staffId, pin: '482915' })).ok).toBe(false);
  });

  it('the op payloads carry ONLY {targetUserId, verifierRef} — no salt/hash bytes anywhere', async () => {
    const s = await setup(9, { staff: '482915' });
    await changePin(s.flowDeps(), { userId: s.h.staffId, currentPin: '482915', newPin: '593026' });
    await resetPin(s.flowDeps(), {
      actorUserId: s.h.ownerId,
      targetUserId: s.h.staffId,
      newPin: '361548',
    });

    const stored = await readVerifier(s.h.db, s.h.staffId);
    const ops = (await s.pinOps()).filter(
      (o) => o.type === 'auth.pin_changed' || o.type === 'auth.pin_reset',
    );
    expect(ops.length).toBeGreaterThanOrEqual(2);
    for (const op of ops) {
      const payload = JSON.parse(op.payload) as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(['targetUserId', 'verifierRef']);
    }
    // Serialized-payload byte scan across a full change/reset cycle: no salt/hash material.
    const serialized = ops.map((o) => o.payload).join('|');
    expect(serialized).not.toContain(stored!.saltB64);
    expect(serialized).not.toContain(stored!.hashB64);
  });
});

describe('first PIN is only for the owner who enrolled this device', () => {
  it('refused for anyone else, even with no PIN: a stale phone cannot hand out a colleague’s account', async () => {
    const s = await setup(7);
    await enrolledBy(s, s.h.ownerId);
    expect(await firstPinUserOnThisDevice(s.h.db)).not.toBe(s.h.staffId);
    await expectDomain(
      setFirstPin(s.flowDeps(), { userId: s.h.staffId, pin: '274816' }),
      'INVALID_TRANSITION',
    );
    expect(await readVerifier(s.h.db, s.h.staffId)).toBeNull();
  });

  it('works once: after the enrolling owner makes theirs, nobody can use the path again', async () => {
    const s = await setup(7);
    await enrolledBy(s, s.h.staffId);
    expect(await firstPinUserOnThisDevice(s.h.db)).toBe(s.h.staffId);
    await setFirstPin(s.flowDeps(), { userId: s.h.staffId, pin: '274816' });
    expect(await firstPinUserOnThisDevice(s.h.db)).toBeNull();
  });

  it('two quick submits make one PIN: the second is refused, not a second op', async () => {
    const s = await setup(7);
    await enrolledBy(s, s.h.staffId);
    const first = setFirstPin(s.flowDeps(), { userId: s.h.staffId, pin: '274816' });
    const second = setFirstPin(s.flowDeps(), { userId: s.h.staffId, pin: '639174' });
    await first;
    await expectDomain(second, 'INVALID_TRANSITION', 'pin_already_set');
    expect(await readPendingVerifiers(s.h.db)).toHaveLength(1);
  });

  it('a device with no enrolling owner on record allows nobody', async () => {
    const s = await setup(7);
    await expectDomain(
      setFirstPin(s.flowDeps(), { userId: s.h.staffId, pin: '274816' }),
      'INVALID_TRANSITION',
    );
  });
});

describe('verifier-POST queue (api/02-auth §5.4)', () => {
  it('queues the upload on disk with the op’s verifierRef, acting as the resetting owner', async () => {
    const s = await setup(12, { staff: '482915' });
    const pending = await resetPin(s.flowDeps(), {
      actorUserId: s.h.ownerId,
      targetUserId: s.h.staffId,
      newPin: '593026',
    });
    const [op] = (await s.pinOps()).filter((o) => o.type === 'auth.pin_reset');
    expect(JSON.parse(op!.payload)).toMatchObject({ verifierRef: pending.verifierRef });

    // Read back from the table, not from anything the flow returned: this is all an app restart keeps.
    expect(await readPendingVerifiers(s.h.db)).toEqual([
      {
        userId: s.h.staffId,
        actorUserId: s.h.ownerId,
        verifierRef: pending.verifierRef,
        verifier: await readVerifier(s.h.db, s.h.staffId),
      },
    ]);
  });

  it('drains on next contact with the op’s verifierRef; applied:false is terminal (no retry)', async () => {
    const s = await setup(10);
    await enrolledBy(s, s.h.staffId);
    const pending = await setFirstPin(s.flowDeps(), { userId: s.h.staffId, pin: '274816' });
    expect(await readPendingVerifiers(s.h.db)).toHaveLength(1);

    const sent: { userId: string; verifierRef: string }[] = [];
    const staleServer: PinVerifierUploadPort = {
      upload: (userId, verifierRef) => {
        sent.push({ userId, verifierRef });
        return Promise.resolve({ userId, applied: false }); // server already has a newer verifier
      },
    };
    const first = await drainPendingVerifiers(s.h.db, staleServer);
    expect(first[0]).toMatchObject({
      verifierRef: pending.verifierRef,
      sent: true,
      result: { applied: false },
    });
    expect(sent[0]!.verifierRef).toBe(pending.verifierRef);
    expect(
      await readPendingVerifiers(s.h.db),
      'applied:false is terminal — dropped, not retried',
    ).toHaveLength(0);

    // Draining again sends nothing (no retry loop, no rollback).
    const second = await drainPendingVerifiers(s.h.db, staleServer);
    expect(second).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });

  it('a PIN change whose upload cannot be queued does not land at all (one transaction)', async () => {
    const s = await setup(13, { staff: '482915' });
    const before = await readVerifier(s.h.db, s.h.staffId);
    // Stand-in for the app dying mid-change: the queue write fails after the op row is inserted.
    await sql`DROP TABLE pending_pin_verifiers`.execute(s.h.db);

    await expect(
      changePin(s.flowDeps(), { userId: s.h.staffId, currentPin: '482915', newPin: '593026' }),
    ).rejects.toThrow();
    expect(
      (await s.pinOps()).filter((o) => o.type === 'auth.pin_changed'),
      'no PIN op is left to sync without its verifier',
    ).toHaveLength(0);
    expect(await readVerifier(s.h.db, s.h.staffId), 'the old PIN still stands').toEqual(before);
  });

  it('a transport error re-queues; the idempotent replay then converges', async () => {
    const s = await setup(11);
    await enrolledBy(s, s.h.staffId);
    await setFirstPin(s.flowDeps(), { userId: s.h.staffId, pin: '274816' });

    let attempts = 0;
    const flaky: PinVerifierUploadPort = {
      upload: (userId) => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error('offline'));
        return Promise.resolve({ userId, applied: true });
      },
    };
    await drainPendingVerifiers(s.h.db, flaky); // throws internally → stays queued
    expect(await readPendingVerifiers(s.h.db)).toHaveLength(1);
    const retry = await drainPendingVerifiers(s.h.db, flaky); // idempotent replay converges
    expect(retry[0]).toMatchObject({ sent: true, result: { applied: true } });
    expect(await readPendingVerifiers(s.h.db)).toHaveLength(0);
  });
});

/** Decode base64 to a byte count without pulling node Buffer into the assertion. */
function atobLen(b64: string): ArrayLike<number> {
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Record `userId` as the owner who enrolled this device, as `runEnrollment` does. */
async function enrolledBy(
  s: { readonly h: { readonly db: Kysely<ClientDatabase> } },
  userId: string,
) {
  await writeMeta(s.h.db, FIRST_PIN_USER_META_KEY, userId);
}
