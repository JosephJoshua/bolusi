// SEC-AUTH-06 (PIN reset authorization, client arm) + SEC-AUTH-11 (privileged-target, client arm) +
// the PIN set/change/reset flows + the verifier-POST queue. The forged-op push rejection
// (SCOPE_VIOLATION) is the SERVER arm — tasks 13/16 — cross-referenced here, never implemented.
import { afterEach, describe, expect, it } from 'vitest';

import {
  changePin,
  changePinCommand,
  clearPinLockoutFlow,
  createLockedOutEmitter,
  DomainError,
  PinVerifierQueue,
  readVerifier,
  resetPin,
  setFirstPin,
  verifyPin,
  writePinAttempt,
  type PinFlowDeps,
  type PinVerifierUploadPort,
} from '../../src/index.js';
import type { ClientDatabase } from '@bolusi/db-client';

import { makeFastCrypto, openAuthHarness, spyKdf, type AuthHarness } from './_harness.js';

let harness: AuthHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

interface Setup {
  readonly h: AuthHarness;
  readonly queue: PinVerifierQueue;
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
  const queue = new PinVerifierQueue();
  const emitter = createLockedOutEmitter(h.runtime);
  return {
    h,
    queue,
    flowDeps: () => ({
      runtime: h.runtime,
      db: h.db,
      crypto: h.crypto,
      clock: h.clock,
      idSource: h.idSource,
      deviceId: h.deviceId,
      queue,
      emitter,
    }),
    pinOps: async () => {
      const rows = await h.db
        .selectFrom('operations')
        .select(['type', 'userId', 'entityId', 'seq', 'timestampMs', 'deviceId', 'payload'])
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
        payload: r.payload,
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
  it('auth.changePin targeting non-self → PERMISSION_DENIED reason restriction_violated (§5.4.6)', async () => {
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
    // Nothing was appended — the pure handler threw before any op.
    expect((await s.pinOps()).filter((o) => o.type === 'auth.pin_changed')).toHaveLength(0);
  });

  it('auth.resetPin without auth.user_reset_pin → PERMISSION_DENIED + auth.permission_denied emitted', async () => {
    const s = await setup(2);
    // staff lacks auth.user_reset_pin. Target (storeOwner) is a valid, non-main-owner directory user.
    await expectDomain(
      resetPin(s.flowDeps(), {
        actorUserId: s.h.staffId,
        targetUserId: s.h.storeOwnerId,
        newPin: '222222',
      }),
      'PERMISSION_DENIED',
    );
    const denials = (await s.pinOps()).filter((o) => o.type === 'auth.permission_denied');
    expect(denials, 'the denial is logged (02 §7)').toHaveLength(1);
    expect(denials[0]!.userId).toBe(s.h.staffId);
    expect((await s.pinOps()).filter((o) => o.type === 'auth.pin_reset')).toHaveLength(0);
  });

  it('reset target absent from users_directory → denied restriction_violated (no op)', async () => {
    const s = await setup(3);
    await expectDomain(
      resetPin(s.flowDeps(), {
        actorUserId: s.h.ownerId,
        targetUserId: 'b2222222-2222-7222-8222-222222222222',
        newPin: '222222',
      }),
      'PERMISSION_DENIED',
      'restriction_violated',
    );
    expect(await s.pinOps()).toHaveLength(0);
  });

  it('auth.clearPinLockout without auth.pin_unlock → denied (+ denial op)', async () => {
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
    expect((await s.pinOps()).filter((o) => o.type === 'auth.pin_lockout_cleared')).toHaveLength(0);
  });
});

describe('SEC-AUTH-11 client arm — privileged-target PIN reset (api/02-auth §6.6)', () => {
  it('store_owner resetting a main_owner-role holder → denied at the command layer', async () => {
    const s = await setup(5);
    // storeOwner HOLDS auth.user_reset_pin, but the target (owner) holds main_owner and the actor does
    // not → the privileged-target rule denies BEFORE the command's permission check.
    await expectDomain(
      resetPin(s.flowDeps(), {
        actorUserId: s.h.storeOwnerId,
        targetUserId: s.h.ownerId,
        newPin: '222222',
      }),
      'PERMISSION_DENIED',
      'restriction_violated',
    );
    expect((await s.pinOps()).filter((o) => o.type === 'auth.pin_reset')).toHaveLength(0);
    // (Forged-op push → SCOPE_VIOLATION is the server arm, tasks 13/16 — not implemented here.)
  });

  it('main_owner actor resetting the same main_owner-role target → allowed + audited', async () => {
    const s = await setup(6);
    await resetPin(s.flowDeps(), {
      actorUserId: s.h.ownerId,
      targetUserId: s.h.ownerId,
      newPin: '222222',
    });
    const resets = (await s.pinOps()).filter((o) => o.type === 'auth.pin_reset');
    expect(resets).toHaveLength(1);
    expect(resets[0]!.userId, 'attributed to the acting main owner').toBe(s.h.ownerId);
    expect(resets[0]!.entityId).toBe(s.h.ownerId);
  });
});

describe('PIN flows (api/02-auth §6.6) — verifier-free payloads, asOf, fresh salt', () => {
  it('first-PIN: forced setup, current-PIN check skipped, local write at the op asOf, fresh salt', async () => {
    const s = await setup(7); // staff has NO verifier by default → first-PIN territory
    const pending = await setFirstPin(s.flowDeps(), { userId: s.h.staffId, pin: '123456' });

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
          { userId: s.h.staffId, pin: '123456' },
        )
      ).ok,
    ).toBe(true);
  });

  it('change: the current PIN is verified before execution; a wrong current PIN is refused', async () => {
    const s = await setup(8, { staff: '111111' });
    // Wrong current PIN → NOT_AUTHENTICATED, no new verifier, no op.
    await expectDomain(
      changePin(s.flowDeps(), { userId: s.h.staffId, currentPin: '000000', newPin: '222222' }),
      'NOT_AUTHENTICATED',
    );
    expect((await s.pinOps()).filter((o) => o.type === 'auth.pin_changed')).toHaveLength(0);

    // Correct current PIN → change succeeds; new PIN verifies, old does not; salt is fresh.
    const before = await readVerifier(s.h.db, s.h.staffId);
    await changePin(s.flowDeps(), { userId: s.h.staffId, currentPin: '111111', newPin: '222222' });
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
    expect((await verifyPin(deps, { userId: s.h.staffId, pin: '222222' })).ok).toBe(true);
    expect((await verifyPin(deps, { userId: s.h.staffId, pin: '111111' })).ok).toBe(false);
  });

  it('the op payloads carry ONLY {targetUserId, verifierRef} — no salt/hash bytes anywhere', async () => {
    const s = await setup(9, { staff: '111111' });
    await changePin(s.flowDeps(), { userId: s.h.staffId, currentPin: '111111', newPin: '222222' });
    await resetPin(s.flowDeps(), {
      actorUserId: s.h.ownerId,
      targetUserId: s.h.staffId,
      newPin: '333333',
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

describe('verifier-POST queue (api/02-auth §5.4)', () => {
  it('drains on next contact with the op’s verifierRef; applied:false is terminal (no retry)', async () => {
    const s = await setup(10);
    const pending = await setFirstPin(s.flowDeps(), { userId: s.h.staffId, pin: '123456' });
    expect(s.queue.size).toBe(1);

    const sent: { userId: string; verifierRef: string }[] = [];
    const staleServer: PinVerifierUploadPort = {
      upload: (userId, verifierRef) => {
        sent.push({ userId, verifierRef });
        return Promise.resolve({ userId, applied: false }); // server already has a newer verifier
      },
    };
    const first = await s.queue.drain(staleServer);
    expect(first[0]).toMatchObject({
      verifierRef: pending.verifierRef,
      sent: true,
      result: { applied: false },
    });
    expect(sent[0]!.verifierRef).toBe(pending.verifierRef);
    expect(s.queue.size, 'applied:false is terminal — dropped, not retried').toBe(0);

    // Draining again sends nothing (no retry loop, no rollback).
    const second = await s.queue.drain(staleServer);
    expect(second).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });

  it('a transport error re-queues; the idempotent replay then converges', async () => {
    const s = await setup(11);
    await setFirstPin(s.flowDeps(), { userId: s.h.staffId, pin: '123456' });

    let attempts = 0;
    const flaky: PinVerifierUploadPort = {
      upload: (userId) => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error('offline'));
        return Promise.resolve({ userId, applied: true });
      },
    };
    await s.queue.drain(flaky); // throws internally → stays queued
    expect(s.queue.size).toBe(1);
    const retry = await s.queue.drain(flaky); // idempotent replay converges
    expect(retry[0]).toMatchObject({ sent: true, result: { applied: true } });
    expect(s.queue.size).toBe(0);
  });
});

/** Decode base64 to a byte count without pulling node Buffer into the assertion. */
function atobLen(b64: string): ArrayLike<number> {
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
