// SEC-AUTH-07 (user switch attributed) + SEC-AUTH-08 (idle lock preserves work). The switcher/
// session state machine against the real command runtime + real op log: the emission order, the
// envelope attribution, the unbroken device chain, the permission-memo invalidation, switcher
// usability, and per-user work retention.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sql } from 'kysely';

import {
  createLockedOutEmitter,
  createWorkStore,
  deleteWorkExcept,
  DEVICE_WORK_KEY,
  listSwitcherUsers,
  resolveUserName,
  SessionManager,
  verifyPin,
  type PermissionMemo,
  type WorkStore,
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

async function setup(
  seed: number,
  idleLockSeconds?: number,
  workStore?: (h: AuthHarness) => WorkStore<{ draft: string }>,
): Promise<Setup> {
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
    ...(workStore !== undefined ? { workStore: workStore(h) } : {}),
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

  it('a lock whose session_ended append fails still ends the session (fails closed)', async () => {
    const s = await setup(61, 60);
    await s.sm.switchTo(s.h.ownerId);
    const append = vi.spyOn(s.h.runtime, 'emitRuntimeOp').mockRejectedValue(new Error('disk full'));

    const manual = s.sm.manualLock();
    // Cleared on the call, before the append settles: nothing can act as the user in between.
    expect(s.sm.current).toBeNull();
    await expect(manual).rejects.toThrow('disk full');
    expect(s.sm.current).toBeNull();

    // The idle path too.
    append.mockRestore();
    await s.sm.switchTo(s.h.ownerId);
    vi.spyOn(s.h.runtime, 'emitRuntimeOp').mockRejectedValue(new Error('disk full'));
    s.h.clock.advance(61_000);
    await expect(s.sm.checkIdle()).rejects.toThrow('disk full');
    expect(s.sm.current).toBeNull();
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

type Work = { draft: string };

function parseWork(value: unknown): Work | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const draft = (value as { draft?: unknown }).draft;
  return typeof draft === 'string' ? { draft } : undefined;
}

function sqliteStore(h: AuthHarness): WorkStore<Work> {
  // Nothing else writes here at once: the store's writes need no queue to wait in.
  return createWorkStore(
    h.db,
    parseWork,
    () => h.clock.now(),
    (fn) => fn(),
  );
}

/** A new manager over the same database: what the app builds after Android killed it. */
function restarted(
  h: AuthHarness,
  store: WorkStore<Work>,
  onWorkStoreError?: (error: unknown) => void,
): SessionManager<Work> {
  return new SessionManager<Work>({
    runtime: h.runtime,
    idSource: h.idSource,
    clock: h.clock,
    memo: h.evaluator,
    workStore: store,
    ...(onWorkStoreError !== undefined ? { onWorkStoreError } : {}),
  });
}

describe('work outlives the app process', () => {
  it('a restart hands the saved work back to the SAME user only, after their switch-in', async () => {
    const s = await setup(9, undefined, sqliteStore);
    await s.sm.switchTo(s.h.ownerId);
    s.sm.saveWork(s.h.ownerId, { draft: 'Bu Rina, 0812, sandi 1234' });
    await s.sm.flushWork();

    const next = restarted(s.h, sqliteStore(s.h));
    expect(next.work(s.h.ownerId)).toBeUndefined();
    expect((await next.switchTo(s.h.staffId)).work).toBeUndefined();
    expect((await next.switchTo(s.h.ownerId)).work).toEqual({ draft: 'Bu Rina, 0812, sandi 1234' });
    // Read once, then held like any other retained work.
    expect(next.work(s.h.ownerId)).toEqual({ draft: 'Bu Rina, 0812, sandi 1234' });
  });

  it('a burst of edits writes only the newest work, in order, and the row ends on the last edit', async () => {
    let s: Setup | null = null;
    const written: string[] = [];
    s = await setup(10, undefined, (h) => {
      const real = sqliteStore(h);
      return {
        load: (userId) => real.load(userId),
        save: async (userId, work) => {
          written.push(work.draft);
          await real.save(userId, work);
        },
      };
    });
    await s.sm.switchTo(s.h.ownerId);
    for (let i = 1; i <= 30; i += 1) s.sm.saveWork(s.h.ownerId, { draft: `ketik ${i}` });
    await s.sm.flushWork();

    expect(written.length).toBeLessThan(30);
    expect(written.at(-1)).toBe('ketik 30');
    expect(await sqliteStore(s.h).load(s.h.ownerId)).toEqual({ draft: 'ketik 30' });
  });

  it('a failing store never blocks the unlock or loses the work in memory', async () => {
    const s = await setup(11);
    const errors: unknown[] = [];
    const broken: WorkStore<Work> = {
      load: async () => {
        throw new Error('disk gone');
      },
      save: async () => {
        throw new Error('disk full');
      },
    };
    const sm = restarted(s.h, broken, (error) => errors.push(error));

    const { session, work } = await sm.switchTo(s.h.ownerId);
    expect(session.userId).toBe(s.h.ownerId);
    expect(work).toBeUndefined();
    sm.saveWork(s.h.ownerId, { draft: 'tetap ada' });
    await sm.flushWork();
    expect(sm.work(s.h.ownerId)).toEqual({ draft: 'tetap ada' });
    expect(errors.map((e) => (e as Error).message)).toEqual(['disk gone', 'disk full']);
  });

  it('a row an older build wrote in another shape starts the user fresh', async () => {
    const s = await setup(12);
    await sql`INSERT INTO user_work (user_id, work, updated_at) VALUES (${s.h.ownerId}, ${'{"old":1}'}, 1)`.execute(
      s.h.db,
    );
    await sql`INSERT INTO user_work (user_id, work, updated_at) VALUES (${s.h.staffId}, ${'not json'}, 1)`.execute(
      s.h.db,
    );
    const sm = restarted(s.h, sqliteStore(s.h));
    expect((await sm.switchTo(s.h.ownerId)).work).toBeUndefined();
    expect((await sm.switchTo(s.h.staffId)).work).toBeUndefined();
  });

  it('work saved while the disk read is still running wins over the older saved copy', async () => {
    const s = await setup(13);
    let release: () => void = () => undefined;
    const slow: WorkStore<Work> = {
      load: () =>
        new Promise((resolve) => {
          release = () => resolve({ draft: 'lama' });
        }),
      save: async () => undefined,
    };
    const sm = restarted(s.h, slow);
    const switching = sm.switchTo(s.h.ownerId);
    // Let the switch reach the read, then edit before the read returns.
    await new Promise((resolve) => setTimeout(resolve, 0));
    sm.saveWork(s.h.ownerId, { draft: 'baru' });
    release();
    expect((await switching).work).toEqual({ draft: 'baru' });
  });

  it('saved work of anyone off the roster is deleted, everyone else keeps theirs', async () => {
    const s = await setup(14);
    const store = sqliteStore(s.h);
    await store.save(s.h.ownerId, { draft: 'milik owner' });
    await store.save(s.h.staffId, { draft: 'milik staf yang keluar' });

    await deleteWorkExcept(s.h.db, [s.h.ownerId]);
    expect(await store.load(s.h.ownerId)).toEqual({ draft: 'milik owner' });
    expect(await store.load(s.h.staffId)).toBeUndefined();

    await deleteWorkExcept(s.h.db, []);
    expect(await store.load(s.h.ownerId)).toBeUndefined();
  });

  it("the device's own work stays while anyone can sign in, and goes with the last of them", async () => {
    const s = await setup(15);
    const store = sqliteStore(s.h);
    await store.save(DEVICE_WORK_KEY, { draft: 'servisan setengah jadi' });
    await deleteWorkExcept(s.h.db, [s.h.ownerId]);
    expect(await store.load(DEVICE_WORK_KEY)).toEqual({ draft: 'servisan setengah jadi' });
    await deleteWorkExcept(s.h.db, []);
    expect(await store.load(DEVICE_WORK_KEY)).toBeUndefined();
  });

  it("the device's own work is read and kept only while someone is signed in, across a restart", async () => {
    const s = await setup(16);
    const store = sqliteStore(s.h);
    const sm = restarted(s.h, store);
    sm.saveDeviceWork({ draft: 'terkunci' });
    expect(await store.load(DEVICE_WORK_KEY)).toBeUndefined();
    await sm.switchTo(s.h.staffId);
    sm.saveDeviceWork({ draft: 'dimulai staf' });
    await sm.flushWork();
    await sm.manualLock();
    expect(await sm.deviceWork()).toBeUndefined();

    const next = restarted(s.h, store);
    await next.switchTo(s.h.ownerId);
    expect(await next.deviceWork()).toEqual({ draft: 'dimulai staf' });
    // Still nobody else's own work.
    expect((await next.switchTo(s.h.ownerId)).work).toBeUndefined();
  });
});
