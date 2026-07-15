// SEC-AUTH-02/03/04/05 end-to-end against a real client DB (testing-guide §2.1 L2). The lockout
// machine, its FakeClock-exact schedule, the KDF-invocation spy proving no argon2id runs during a
// window/lock, restart persistence, clock rollback, the hard lock + its `auth.pin_locked_out` op,
// and both OFFLINE recovery paths — plus the class sweep (T-12) and positive controls (T-14b).
//
// The KDF is a fast, input-sensitive fake (makeFastCrypto) wrapped in an invocation spy: the LOGIC
// under test is the machine, not argon2id (SEC-AUTH-01 proves the real params). "Assert the outcome,
// not the mechanism": every deny checks that the wrong PIN did NOT unlock and the KDF was NOT run.
import { afterEach, describe, expect, it } from 'vitest';

import {
  clearPinLockoutFlow,
  createLockedOutEmitter,
  DomainError,
  PinVerifierQueue,
  readPinAttempt,
  resetPin,
  verifyPin,
  type LockedOutEmitter,
  type PinFlowDeps,
  type PinVerifyResult,
} from '../../src/index.js';
import type { ClientDatabase } from '@bolusi/db-client';
import { CamelCasePlugin, Kysely } from 'kysely';
import { createClientDialect } from '@bolusi/db-client';

import { makeFastCrypto, openAuthHarness, spyKdf, type AuthHarness } from './_harness.js';

let harness: AuthHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

interface Setup {
  readonly h: AuthHarness;
  readonly emitter: LockedOutEmitter;
  readonly kdf: () => number;
  attempt(pin: string): Promise<PinVerifyResult>;
  failPastWindow(): Promise<PinVerifyResult>;
  flowDeps(): PinFlowDeps<ClientDatabase>;
}

const PIN = '111111';

async function setup(seed: number): Promise<Setup> {
  const spy = spyKdf(makeFastCrypto());
  const h = await openAuthHarness(seed, { crypto: spy.crypto, verifiers: { staff: PIN } });
  harness = h;
  const baseline = spy.calls();
  const emitter = createLockedOutEmitter(h.runtime);
  const deps = { db: h.db, crypto: h.crypto, clock: h.clock, deviceId: h.deviceId, emitter };
  return {
    h,
    emitter,
    kdf: () => spy.calls() - baseline,
    attempt: (pin) => verifyPin(deps, { userId: h.staffId, pin }),
    async failPastWindow() {
      const row = await readPinAttempt(h.db, h.staffId, h.deviceId);
      if (row?.notBefore != null && h.clock.now() < row.notBefore) h.clock.set(row.notBefore);
      return verifyPin(deps, { userId: h.staffId, pin: '000000' });
    },
    flowDeps: () => ({
      runtime: h.runtime,
      db: h.db,
      crypto: h.crypto,
      clock: h.clock,
      idSource: h.idSource,
      deviceId: h.deviceId,
      queue: new PinVerifierQueue(),
      emitter,
    }),
  };
}

async function expectDomain(p: Promise<unknown>, code: string): Promise<DomainError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError && e.code === code) return e;
    throw new Error(`expected DomainError(${code}), got ${String(e)}`);
  }
  throw new Error(`expected DomainError(${code}), nothing thrown`);
}

describe('SEC-AUTH-02 — escalating lockout schedule; KDF never runs during a window', () => {
  it('3 free attempts, then delay−1ms throws PIN_RATE_LIMITED without running the KDF', async () => {
    const s = await setup(1);
    // Three free wrong attempts — each runs the KDF (evaluated).
    for (let i = 0; i < 3; i += 1) expect((await s.attempt('000000')).ok).toBe(false);
    expect(s.kdf(), 'the 3 free attempts each ran the KDF').toBe(3);

    const row = await readPinAttempt(s.h.db, s.h.staffId, s.h.deviceId);
    expect(row?.consecutiveFailures).toBe(3);
    expect(row?.notBefore).toBe(s.h.clock.now() + 30_000);

    // At delay − 1 ms: refused, NO KDF (wrong OR correct PIN).
    s.h.clock.set(row!.notBefore! - 1);
    const err = await expectDomain(s.attempt('000000'), 'PIN_RATE_LIMITED');
    expect(err.details).toMatchObject({ retryAt: row!.notBefore });
    await expectDomain(s.attempt(PIN), 'PIN_RATE_LIMITED'); // the CORRECT PIN is refused too
    expect(s.kdf(), 'no KDF ran during the delay window').toBe(3);

    // At exactly delay: evaluated again (KDF runs), count advances to 4.
    s.h.clock.set(row!.notBefore!);
    expect((await s.attempt('000000')).ok).toBe(false);
    expect(s.kdf()).toBe(4);
    expect((await readPinAttempt(s.h.db, s.h.staffId, s.h.deviceId))?.consecutiveFailures).toBe(4);
  });
});

describe('SEC-AUTH-03 — lockout survives a restart', () => {
  it('fail 5×, discard in-memory state and reopen the DB → counter + notBefore intact', async () => {
    const s = await setup(2);
    for (let i = 0; i < 5; i += 1) await s.failPastWindow();
    const before = await readPinAttempt(s.h.db, s.h.staffId, s.h.deviceId);
    expect(before?.consecutiveFailures).toBe(5);
    expect(before?.notBefore).not.toBeNull();

    // "Restart": a brand-new Kysely handle over the SAME persisted DB — no in-memory state carries.
    const reopened = new Kysely<ClientDatabase>({
      dialect: createClientDialect(s.h.driver),
      plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
    });
    const after = await readPinAttempt(reopened, s.h.staffId, s.h.deviceId);
    expect(after).toEqual(before); // the row stands, byte for byte
    await reopened.destroy();

    // And the next attempt is still delayed (within the window).
    s.h.clock.set(before!.notBefore! - 1);
    await expectDomain(s.attempt(PIN), 'PIN_RATE_LIMITED');
  });
});

describe('SEC-AUTH-04 — clock rollback does not shrink the window', () => {
  it('fail 5×, roll the clock back 1 h → stored notBefore wins, unchanged', async () => {
    const s = await setup(3);
    for (let i = 0; i < 5; i += 1) await s.failPastWindow();
    const row = await readPinAttempt(s.h.db, s.h.staffId, s.h.deviceId);
    const storedNotBefore = row!.notBefore!;

    s.h.clock.set(s.h.clock.now() - 3_600_000); // roll back 1 hour
    const err = await expectDomain(s.attempt(PIN), 'PIN_RATE_LIMITED');
    expect(err.details).toMatchObject({ retryAt: storedNotBefore }); // NOT recomputed downward
    // The stored row is untouched by the refused, unevaluated attempt.
    expect((await readPinAttempt(s.h.db, s.h.staffId, s.h.deviceId))?.notBefore).toBe(
      storedNotBefore,
    );
  });
});

describe('SEC-AUTH-05 — hard lock at the 10th failure + offline recovery', () => {
  it('10th failure locks, emits auth.pin_locked_out, and disables the PIN path (PIN_LOCKED)', async () => {
    const s = await setup(4);
    for (let i = 0; i < 10; i += 1) await s.failPastWindow();
    const kdfAtLock = s.kdf();

    const lockOps = (await s.h.ops()).filter((o) => o.type === 'auth.pin_locked_out');
    expect(lockOps).toHaveLength(1);
    expect(lockOps[0]!.userId).toBe(s.h.staffId);
    expect(lockOps[0]!.source).toBe('system');
    expect(JSON.parse(lockOps[0]!.payload)).toMatchObject({ consecutiveFailures: 10 });
    expect(JSON.parse(lockOps[0]!.payload).windowStartedAt).toBeTypeOf('number');

    // Locked: even the CORRECT PIN throws PIN_LOCKED, and the KDF does not run (no oracle).
    await expectDomain(s.attempt(PIN), 'PIN_LOCKED');
    expect(s.kdf(), 'no KDF while locked_out').toBe(kdfAtLock);
  });

  it('owner unlock (auth.clearPinLockout) restores it OFFLINE — zero network', async () => {
    const s = await setup(5);
    for (let i = 0; i < 10; i += 1) await s.failPastWindow();
    await expectDomain(s.attempt(PIN), 'PIN_LOCKED');

    // clearPinLockout takes NO transport — recovery is purely local (offline-capable, §6.5).
    const outcome = await clearPinLockoutFlow(s.flowDeps(), {
      actorUserId: s.h.ownerId,
      targetUserId: s.h.staffId,
    });
    expect(outcome.ops[0]!.status).toBe('appended');
    const clearOps = (await s.h.ops()).filter((o) => o.type === 'auth.pin_lockout_cleared');
    expect(clearOps).toHaveLength(1);
    expect(clearOps[0]!.userId).toBe(s.h.ownerId);

    // Now the correct PIN unlocks again (counter reset to 0).
    expect((await s.attempt(PIN)).ok).toBe(true);
  });

  it('owner PIN reset restores it OFFLINE and invalidates the old PIN', async () => {
    const s = await setup(6);
    for (let i = 0; i < 10; i += 1) await s.failPastWindow();
    await expectDomain(s.attempt(PIN), 'PIN_LOCKED');

    await resetPin(s.flowDeps(), {
      actorUserId: s.h.ownerId,
      targetUserId: s.h.staffId,
      newPin: '222222',
    });

    // Lockout cleared; the NEW PIN verifies, the OLD PIN does not.
    expect((await s.attempt('222222')).ok).toBe(true);
    expect((await s.attempt(PIN)).ok).toBe(false); // old PIN invalid everywhere the new verifier reached
  });
});

describe('SEC-AUTH-02/05 class sweep (T-12) + positive controls (T-14b)', () => {
  it('POSITIVE CONTROL — the correct PIN unlocks when NOT locked', async () => {
    const s = await setup(7);
    expect((await s.attempt(PIN)).ok).toBe(true);
    expect(s.kdf()).toBe(1);
  });

  it('a correct PIN mid-lockout stays locked (does NOT unlock), KDF never runs', async () => {
    const s = await setup(8);
    for (let i = 0; i < 10; i += 1) await s.failPastWindow();
    const k = s.kdf();
    // Move the clock FORWARD arbitrarily — the lock is counter-based, not time-based.
    s.h.clock.set(s.h.clock.now() + 10_000_000);
    await expectDomain(s.attempt(PIN), 'PIN_LOCKED');
    expect(s.kdf()).toBe(k);
  });

  it('a successful PIN before the 10th resets the counter to 0', async () => {
    const s = await setup(9);
    for (let i = 0; i < 5; i += 1) await s.failPastWindow();
    // Past the window, the correct PIN succeeds and resets.
    const row = await readPinAttempt(s.h.db, s.h.staffId, s.h.deviceId);
    s.h.clock.set(row!.notBefore!);
    expect((await s.attempt(PIN)).ok).toBe(true);
    expect((await readPinAttempt(s.h.db, s.h.staffId, s.h.deviceId))?.consecutiveFailures).toBe(0);
  });
});
