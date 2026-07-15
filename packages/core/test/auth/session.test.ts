// SEC-AUTH-07 (user switch attributed) + SEC-AUTH-08 (idle lock preserves work). The switcher/
// session state machine against the real command runtime + real op log: the emission order, the
// envelope attribution, the unbroken device chain, the permission-memo invalidation, switcher
// usability, and per-user work retention.
import { afterEach, describe, expect, it } from 'vitest';

import {
  createLockedOutEmitter,
  listSwitcherUsers,
  resolveUserName,
  SessionManager,
  verifyPin,
  type PermissionMemo,
} from '../../src/index.js';

import { makeFastCrypto, openAuthHarness, spyKdf, type AuthHarness } from './_harness.js';

let harness: AuthHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

interface Setup {
  readonly h: AuthHarness;
  readonly sm: SessionManager<{ draft: string }>;
  readonly memoCalls: () => number;
}

async function setup(seed: number, idleLockSeconds?: number): Promise<Setup> {
  const h = await openAuthHarness(seed, {
    crypto: spyKdf(makeFastCrypto()).crypto,
    ...(idleLockSeconds !== undefined ? { idleLockSeconds } : {}),
  });
  harness = h;
  let calls = 0;
  const memo: PermissionMemo = {
    onUserSwitch: async () => {
      calls += 1;
      await h.evaluator.onUserSwitch();
    },
  };
  const sm = new SessionManager<{ draft: string }>({
    runtime: h.runtime,
    idSource: h.idSource,
    clock: h.clock,
    memo,
    idleLockSeconds: h.bundle.settings.idleLockSeconds,
  });
  return { h, sm, memoCalls: () => calls };
}

describe('SEC-AUTH-07 — user switch is attributed and the chain stays unbroken', () => {
  it('A→B emits session_ended(switch) then user_switched, both envelope userId = B', async () => {
    const s = await setup(1);
    // First switch: no previous session → only user_switched, userId = A (owner).
    await s.sm.switchTo(s.h.ownerId);
    // Second switch A→B: session_ended(switch) THEN user_switched, both userId = B (staff).
    const { session: bSession } = await s.sm.switchTo(s.h.staffId);

    const ops = await s.h.ops();
    const switchOps = ops.filter(
      (o) => o.type === 'auth.user_switched' || o.type === 'auth.session_ended',
    );
    // genesis is auth.device_enrolled; then user_switched(A), session_ended(switch), user_switched(B).
    expect(switchOps.map((o) => o.type)).toEqual([
      'auth.user_switched',
      'auth.session_ended',
      'auth.user_switched',
    ]);
    const [switchedA, endedSwitch, switchedB] = switchOps;
    expect(switchedA!.userId).toBe(s.h.ownerId);
    // BOTH the session-end and the switch-in carry the INCOMING user (B).
    expect(endedSwitch!.userId).toBe(s.h.staffId);
    expect(switchedB!.userId).toBe(s.h.staffId);
    expect(JSON.parse(endedSwitch!.payload)).toEqual({ reason: 'switch' });
    expect(switchedB!.entityId).toBe(bSession.sessionId);
    // session_ended targets the OUTGOING (A's) session; user_switched(B) names A as previous.
    expect(JSON.parse(switchedB!.payload).previousUserId).toBe(s.h.ownerId);
  });

  it('ops after the switch carry B, ops before carry A, and the device chain is contiguous', async () => {
    const s = await setup(2, undefined);
    await s.sm.switchTo(s.h.ownerId);
    // An op as A (owner): manual lock ends A's session, attributed to A.
    await s.sm.manualLock();
    await s.sm.switchTo(s.h.staffId);
    await s.sm.manualLock(); // an op as B (staff)

    const ops = await s.h.ops();
    // The chain is unbroken: seq 1..N contiguous, each previousHash = the prior op's hash.
    for (let i = 0; i < ops.length; i += 1) {
      expect(ops[i]!.seq, 'contiguous seq').toBe(i + 1);
      if (i === 0) expect(ops[i]!.previousHash).toBe('0'.repeat(64));
      else expect(ops[i]!.previousHash, `link at seq ${i + 1}`).toBe(ops[i - 1]!.hash);
    }
    // The manual_lock BEFORE the B switch is A's; the one AFTER is B's.
    const locks = ops.filter(
      (o) => o.type === 'auth.session_ended' && JSON.parse(o.payload).reason === 'manual_lock',
    );
    expect(locks[0]!.userId).toBe(s.h.ownerId);
    expect(locks[1]!.userId).toBe(s.h.staffId);
  });

  it('switching in requires no permission and invalidates the permission memo (§6)', async () => {
    const s = await setup(3);
    // staff holds nothing but pin_change — switching in still works (authn precedes authz, FR-1014).
    await s.sm.switchTo(s.h.staffId);
    await s.sm.switchTo(s.h.ownerId);
    expect(s.memoCalls(), 'onUserSwitch fired per switch').toBe(2);
  });

  it('deactivated users are not switcher-usable while their names remain resolvable (§6)', async () => {
    const s = await setup(4);
    // Deactivate the staff user via a bundle refresh.
    const refreshed = {
      ...s.h.bundle,
      users: s.h.bundle.users.map((u) =>
        u.id === s.h.staffId ? { ...u, status: 'deactivated' as const, pinVerifier: null } : u,
      ),
    };
    const { applyBundle } = await import('../../src/index.js');
    await applyBundle(s.h.db, refreshed);

    const usable = await listSwitcherUsers(s.h.db);
    expect(usable.map((u) => u.id)).not.toContain(s.h.staffId);
    expect(usable.map((u) => u.id)).toContain(s.h.ownerId);
    // Name still resolves for history.
    expect(await resolveUserName(s.h.db, s.h.staffId)).toBe('Budi');
  });
});

describe('SEC-AUTH-08 — idle lock preserves work', () => {
  it('idle past idleLockSeconds ends the session with reason idle_lock, source system', async () => {
    const s = await setup(5, 300);
    await s.sm.switchTo(s.h.ownerId);
    s.sm.recordActivity();

    // Before the timeout: no lock (positive control).
    s.h.clock.advance(299_000);
    expect(await s.sm.checkIdle()).toHaveLength(0);
    expect(s.sm.current).not.toBeNull();

    // Past the timeout: the session ends.
    s.h.clock.advance(2_000); // total 301 s
    const ops = await s.sm.checkIdle();
    expect(ops).toHaveLength(1);
    expect(s.sm.current).toBeNull();
    const ended = (await s.h.ops()).filter((o) => o.type === 'auth.session_ended').at(-1)!;
    expect(JSON.parse(ended.payload)).toEqual({ reason: 'idle_lock' });
    expect(ended.source).toBe('system');
    expect(ended.userId).toBe(s.h.ownerId);
  });

  it('manual lock ends the session with reason manual_lock, source ui', async () => {
    const s = await setup(6);
    await s.sm.switchTo(s.h.ownerId);
    await s.sm.manualLock();
    const ended = (await s.h.ops()).filter((o) => o.type === 'auth.session_ended').at(-1)!;
    expect(JSON.parse(ended.payload)).toEqual({ reason: 'manual_lock' });
    expect(ended.source).toBe('ui');
  });

  it('per-user work survives the lock and is restored to the SAME user, never a different one', async () => {
    const s = await setup(7, 60);
    await s.sm.switchTo(s.h.ownerId);
    s.sm.saveWork(s.h.ownerId, { draft: 'sisa 4 karung' });

    // Idle lock.
    s.h.clock.advance(61_000);
    await s.sm.checkIdle();
    expect(s.sm.current).toBeNull();
    // Work survives the lock and is NOT visible to a different user.
    expect(s.sm.work(s.h.ownerId)).toEqual({ draft: 'sisa 4 karung' });
    expect(s.sm.work(s.h.staffId)).toBeUndefined();

    // The owner's next unlock restores their retained work.
    const { work } = await s.sm.switchTo(s.h.ownerId);
    expect(work).toEqual({ draft: 'sisa 4 karung' });
    // A different user unlocking gets NONE of it.
    const staffSwitch = await s.sm.switchTo(s.h.staffId);
    expect(staffSwitch.work).toBeUndefined();
  });

  it('POSITIVE CONTROL — verifyPin still gates identity independent of the switcher (T-14b)', async () => {
    const s = await setup(8);
    // Sanity: the switcher does not itself grant anything — PIN verify is a separate gate. A user with
    // no verifier cannot be verified in, even after switchTo names them.
    await s.sm.switchTo(s.h.staffId);
    const emitter = createLockedOutEmitter(s.h.runtime);
    await expect(
      verifyPin(
        { db: s.h.db, crypto: s.h.crypto, clock: s.h.clock, deviceId: s.h.deviceId, emitter },
        { userId: s.h.staffId, pin: '111111' },
      ),
    ).rejects.toThrow(); // no verifier → ENTITY_NOT_FOUND (routes to first-PIN)
  });
});
