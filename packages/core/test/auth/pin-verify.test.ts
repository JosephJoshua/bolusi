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
  attemptLockKey,
  readPinAttempt,
  resetPin,
  verifyPin,
  VerifierBoundsError,
  withAttemptLock,
  type LockedOutEmitter,
  type PinFlowDeps,
  type PinVerifyResult,
} from '../../src/index.js';
import type { ClientDatabase } from '@bolusi/db-client';
import { CamelCasePlugin, Kysely, sql } from 'kysely';
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

/**
 * Fire `concurrency` wrong guesses AT ONCE per round, advancing the FakeClock to the open window's
 * `notBefore` between rounds (deterministic — no sleeps, T-6), until the lock engages. Returns how
 * many guesses were actually EVALUATED, measured by the KDF-invocation spy: the KDF runs if and only
 * if the gate let the attempt through, so the spy IS the budget meter.
 */
async function measureBudget(
  s: Setup,
  concurrency: number,
): Promise<{ evaluated: number; locked: boolean; counter: number }> {
  const before = s.kdf();
  let locked = false;
  for (let round = 0; round < 60 && !locked; round += 1) {
    const row = await readPinAttempt(s.h.db, s.h.staffId, s.h.deviceId);
    if (row?.notBefore != null && s.h.clock.now() < row.notBefore) s.h.clock.set(row.notBefore);
    const results = await Promise.all(
      Array.from({ length: concurrency }, () =>
        s.attempt('000000').then(
          (r) => r as unknown,
          (e: unknown) => e,
        ),
      ),
    );
    locked = results.some((r) => r instanceof DomainError && r.code === 'PIN_LOCKED');
  }
  const final = await readPinAttempt(s.h.db, s.h.staffId, s.h.deviceId);
  return { evaluated: s.kdf() - before, locked, counter: final?.consecutiveFailures ?? 0 };
}

describe('the attempt lock key is injective over (userId, deviceId)', () => {
  it('two pairs that concatenate identically get DIFFERENT lock keys', () => {
    // Without a delimiter, ("ab","c") and ("a","bc") both spell "abc" and would share one lock.
    expect(attemptLockKey('ab', 'c')).not.toBe(attemptLockKey('a', 'bc'));
    expect(attemptLockKey('', 'abc')).not.toBe(attemptLockKey('abc', ''));
    // POSITIVE CONTROL: the same pair must map to the SAME key, or the lock would never serialize
    // anything (a key that is merely "unique" is not a lock).
    expect(attemptLockKey('ab', 'c')).toBe(attemptLockKey('ab', 'c'));
  });

  it('the delimiter is a real NUL at RUNTIME even though the source is plain ASCII', () => {
    // The source spells the escape; the runtime string must still carry the actual control char —
    // that is the whole point of writing the escape rather than pasting the byte.
    expect(attemptLockKey('a', 'b')).toBe(`a${String.fromCharCode(0)}b`);
    expect(attemptLockKey('a', 'b')).toHaveLength(3);
  });
});

describe('SEC-AUTH-02 — per-(userId, deviceId) isolation on a shared terminal', () => {
  it('user B still unlocks after user A burns every attempt (api/02-auth §6.5)', async () => {
    // Both users have a verifier on the SAME device — the shared-terminal case §6.5 calls out:
    // "Other users on a shared terminal are never blocked by one user's failures."
    const spy = spyKdf(makeFastCrypto());
    const h = await openAuthHarness(24, {
      crypto: spy.crypto,
      verifiers: { staff: PIN, storeOwner: '999999' },
    });
    harness = h;
    const deps = {
      db: h.db,
      crypto: h.crypto,
      clock: h.clock,
      deviceId: h.deviceId,
      emitter: createLockedOutEmitter(h.runtime),
    };

    // A (staff) burns all 10 and is hard-locked.
    for (let i = 0; i < 10; i += 1) {
      const row = await readPinAttempt(h.db, h.staffId, h.deviceId);
      if (row?.notBefore != null && h.clock.now() < row.notBefore) h.clock.set(row.notBefore);
      await verifyPin(deps, { userId: h.staffId, pin: '000000' });
    }
    await expectDomain(verifyPin(deps, { userId: h.staffId, pin: PIN }), 'PIN_LOCKED');

    // B's counter was never touched, and B's CORRECT PIN still unlocks — A's lock is not B's.
    expect((await readPinAttempt(h.db, h.storeOwnerId, h.deviceId))?.consecutiveFailures ?? 0).toBe(
      0,
    );
    expect((await verifyPin(deps, { userId: h.storeOwnerId, pin: '999999' })).ok).toBe(true);
  });
});

describe('SEC-AUTH-02 — the lockout budget is 10, independent of caller concurrency', () => {
  // api/02-auth §6.5's invariant is literally "10 consecutive failures". Nothing outside core
  // serializes PIN attempts, and N=2 is an ordinary double-tap on a submit button — no attacker
  // required. A read→gate→KDF→write with no atomicity makes the budget 10 x N.
  it('N=1 evaluates exactly 10 wrong guesses before PIN_LOCKED (positive control)', async () => {
    const s = await setup(20);
    const { evaluated, locked, counter } = await measureBudget(s, 1);
    expect(evaluated).toBe(10);
    expect(locked).toBe(true);
    expect(counter).toBe(10);
  });

  it('N=2 (a double-tap) evaluates exactly 10 — not 19', async () => {
    const s = await setup(21);
    const { evaluated, locked, counter } = await measureBudget(s, 2);
    expect(evaluated).toBe(10);
    expect(locked).toBe(true);
    expect(counter).toBe(10);
  });

  it('N=20 evaluates exactly 10 — not 181', async () => {
    const s = await setup(22);
    const { evaluated, locked, counter } = await measureBudget(s, 20);
    expect(evaluated).toBe(10);
    expect(locked).toBe(true);
    expect(counter).toBe(10);
  });
});

describe('SEC-AUTH-02 — a kill mid-KDF fails closed (the attempt is counted, never un-counted)', () => {
  it('a process killed during the ~300ms KDF leaves the failure banked', async () => {
    let crash = false;
    const base = makeFastCrypto();
    const crypto = {
      ...base,
      kdf: (password: Uint8Array, salt: Uint8Array, params: Parameters<typeof base.kdf>[2]) =>
        crash
          ? Promise.reject(new Error('process killed mid-KDF'))
          : base.kdf(password, salt, params),
    };
    const h = await openAuthHarness(23, { crypto, verifiers: { staff: PIN } });
    harness = h;
    const emitter = createLockedOutEmitter(h.runtime);
    const deps = { db: h.db, crypto: h.crypto, clock: h.clock, deviceId: h.deviceId, emitter };

    await verifyPin(deps, { userId: h.staffId, pin: '000000' });
    await verifyPin(deps, { userId: h.staffId, pin: '000000' });
    expect((await readPinAttempt(h.db, h.staffId, h.deviceId))?.consecutiveFailures).toBe(2);

    // The device dies mid-derivation. Under the OPTIMISTIC order this guess would have been free —
    // an attacker who kills the app during every KDF would never burn an attempt.
    crash = true;
    await expect(verifyPin(deps, { userId: h.staffId, pin: PIN })).rejects.toThrow(/killed/);
    expect(
      (await readPinAttempt(h.db, h.staffId, h.deviceId))?.consecutiveFailures,
      'the attempt was banked before the KDF — the crash costs a guess',
    ).toBe(3);
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

describe('SEC-AUTH-01 read-side — a tampered verifier row never reaches the KDF (F2)', () => {
  // The HOSTILE vector is the SERVER bundle, gated at bundle-apply.ts and proven in verifier.test.ts.
  // This closes the LOCAL-DB-write path: a tampered `user_pin_verifiers` row (the only entry here) is
  // rejected on read, before the pessimistic bank and before argon2id runs.
  async function setParams(
    s: Setup,
    params: { mKiB: number; t: number; p: number },
  ): Promise<void> {
    await sql`UPDATE user_pin_verifiers SET params = ${JSON.stringify(params)} WHERE user_id = ${s.h.staffId}`.execute(
      s.h.db,
    );
  }

  it('a 1 GiB memoryCost row is rejected before the KDF (T-11 — prove it, then bound it)', async () => {
    const s = await setup(40);
    await setParams(s, { mKiB: 1_048_576, t: 3, p: 1 }); // the alarming "1 GiB" verifier
    await expect(s.attempt(PIN), 'even the CORRECT PIN cannot ride a tampered row').rejects.toThrow(
      VerifierBoundsError,
    );
    expect(s.kdf(), 'the KDF must not run for an out-of-bounds stored verifier').toBe(0);
    // The banked-failure write is also skipped: a corrupt row is not a wrong-PIN guess.
    expect(
      (await readPinAttempt(s.h.db, s.h.staffId, s.h.deviceId))?.consecutiveFailures ?? 0,
    ).toBe(0);
  });

  // NOTE on `algo`: the `user_pin_verifiers` DDL carries `CHECK (algo = 'argon2id')`, so a non-argon2id
  // algo cannot be STORED through the client DB — its read-side check is belt-and-suspenders (readVerifier
  // reads `row.algo` rather than inventing it, so the guard still holds if that constraint is ever
  // relaxed) and is not tamper-testable here. `p` lives inside the JSON `params` blob with no such
  // constraint, so it IS the field that proves the read-side check is non-vacuous:
  it('a tampered p ≠ 1 is caught — the check reads stored `p`, not a hardcoded constant (T-13)', async () => {
    const s = await setup(42);
    // If readVerifier still hardcoded `p: 1`, this row would read back as p=1 and slip past the
    // bounds check entirely — the exact "validating a value it just invented" trap.
    await setParams(s, { mKiB: 32_768, t: 3, p: 4 });
    await expect(s.attempt(PIN)).rejects.toThrow(VerifierBoundsError);
    expect(s.kdf()).toBe(0);
  });

  it('POSITIVE CONTROL — an untampered floor-params verifier still verifies (T-14b)', async () => {
    const s = await setup(43);
    // The harness builds staff at FLOOR_KDF_PARAMS (mKiB 19456, t 2). A bounds check that rejected
    // everything — or a read-side check that mangled valid params — would fail right here.
    expect((await s.attempt(PIN)).ok).toBe(true);
    expect(s.kdf()).toBe(1);
  });
});

/** Drain the macro-task queue so an UNsynchronized flow would have completed if it were going to. */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
}

describe('SEC-AUTH-02 attempt-lock scope — the sibling pin_attempt_state writes serialize too (F7)', () => {
  it('an owner lockout-clear serializes behind a verify that is mid-KDF (real interleaving)', async () => {
    // A gate makes the interleaving exact: the 10th (losing) attempt banks failure #10, then blocks
    // IN the KDF holding the attempt lock, while the owner tries to clear the same row.
    let openGate: (() => void) | null = null;
    let sawKdf: (() => void) | null = null;
    let gateArmed = false;
    const base = makeFastCrypto();
    const crypto = {
      ...base,
      kdf: async (pw: Uint8Array, salt: Uint8Array, params: Parameters<typeof base.kdf>[2]) => {
        if (gateArmed) {
          sawKdf?.();
          await new Promise<void>((r) => (openGate = r));
        }
        return base.kdf(pw, salt, params);
      },
    };
    const h = await openAuthHarness(30, { crypto, verifiers: { staff: PIN } });
    harness = h;
    const emitter = createLockedOutEmitter(h.runtime);
    const deps = { db: h.db, crypto: h.crypto, clock: h.clock, deviceId: h.deviceId, emitter };
    const flowDeps: PinFlowDeps<ClientDatabase> = {
      runtime: h.runtime,
      db: h.db,
      crypto: h.crypto,
      clock: h.clock,
      idSource: h.idSource,
      deviceId: h.deviceId,
      queue: new PinVerifierQueue(),
      emitter,
    };

    // Drive staff to 9 consecutive failures (gate disarmed → the KDF runs freely).
    for (let i = 0; i < 9; i += 1) {
      const row = await readPinAttempt(h.db, h.staffId, h.deviceId);
      if (row?.notBefore != null && h.clock.now() < row.notBefore) h.clock.set(row.notBefore);
      await verifyPin(deps, { userId: h.staffId, pin: '000000' });
    }
    const pre = await readPinAttempt(h.db, h.staffId, h.deviceId);
    expect(pre?.consecutiveFailures).toBe(9);
    if (pre?.notBefore != null) h.clock.set(pre.notBefore);

    // Arm the gate and fire the 10th attempt.
    const enteredKdf = new Promise<void>((r) => (sawKdf = r));
    gateArmed = true;
    const order: string[] = [];
    const attemptP = verifyPin(deps, { userId: h.staffId, pin: '000000' }).then((r) => {
      order.push('attempt');
      return r;
    });
    await enteredKdf; // deterministic: the attempt is mid-KDF, lock held, failure #10 banked

    // Positive control (T-14b): the fixture ACTUALLY interleaved — the attempt is in flight and the
    // 10th failure is banked (the row reads locked_out), so the window a clear could race is open.
    expect((await readPinAttempt(h.db, h.staffId, h.deviceId))?.consecutiveFailures).toBe(10);

    const clearP = clearPinLockoutFlow(flowDeps, {
      actorUserId: h.ownerId,
      targetUserId: h.staffId,
    }).then(() => order.push('clear'));

    await drain();
    // Serialized: the clear has NOT run, and the in-flight attempt's banked row is un-clobbered.
    expect(order, 'the clear waits behind the mid-KDF attempt').toEqual([]);
    expect((await readPinAttempt(h.db, h.staffId, h.deviceId))?.consecutiveFailures).toBe(10);

    // Release the KDF: the attempt settles FIRST, then the clear runs — an order, not a race.
    openGate!();
    await Promise.all([attemptP, clearP]);
    expect(order).toEqual(['attempt', 'clear']);
    expect((await readPinAttempt(h.db, h.staffId, h.deviceId))?.consecutiveFailures).toBe(0);
  });

  it("a PIN reset's counter clear routes through the attempt lock (held-lock stand-in)", async () => {
    const s = await setup(31);
    // Hold the attempt lock for (staff, device) with a promise we control — a stand-in for a verify
    // in flight. resetPin runs its command + KDF + verifier write freely, then its counter-reset
    // write must QUEUE behind this held lock (F7), proving that write shares the one lock domain.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const occupied = withAttemptLock(attemptLockKey(s.h.staffId, s.h.deviceId), () => held);

    let resetDone = false;
    const resetP = resetPin(s.flowDeps(), {
      actorUserId: s.h.ownerId,
      targetUserId: s.h.staffId,
      newPin: '222222',
    }).then(() => {
      resetDone = true;
    });

    await drain();
    expect(resetDone, "the reset's counter write waits behind the held attempt lock").toBe(false);

    release();
    await occupied;
    await resetP;
    expect(resetDone).toBe(true);
    // The reset applied: counter is 0 and the new PIN verifies.
    expect(
      (await readPinAttempt(s.h.db, s.h.staffId, s.h.deviceId))?.consecutiveFailures ?? 0,
    ).toBe(0);
    expect((await s.attempt('222222')).ok).toBe(true);
  });
});
