// CHAOS-11 — PIN rate-limit escalation timing (testing-guide §3.6; lockout machine owned by
// api/02-auth §6.5). Drives the PRODUCTION offline-PIN verify + lockout machine + recovery flows over
// the harness pin-fixture (T-7 — no auth logic re-implemented here). The escalation SCHEDULE is
// imported from the auth package's exported constants (`PIN_LOCKOUT_SCHEDULE`,
// `delayMsForFailureCount`, `PIN_FREE_ATTEMPTS`, `PIN_HARD_LOCK_THRESHOLD`) — this scenario declares
// no numeric delay literal of its own (§3.6: "must not duplicate the numbers as literals").
//
// PASS (§3.6): under FakeClock, an attempt at `delay − 1 ms` throws PIN_RATE_LIMITED, at `delay` is
// evaluated; during a window/lock a wrong OR correct PIN is refused WITHOUT running argon2id (the
// KDF-invocation spy stays flat — no battery/timing oracle); the 10th consecutive failure enters
// `locked_out` and emits `auth.pin_locked_out`; a success before the 10th resets the counter; both
// OFFLINE recovery paths (owner unlock + owner PIN reset) clear the lock with ZERO network calls (a
// FaultFetch witnesses none); the lock survives a restart (state discard + DB reopen); a FakeClock
// rollback never shortens a `notBefore` window.
//
// Falsification (§2.11 / T-17): a deny suite is trivially green if the verifier rejects EVERYTHING —
// so the positive control watches the fence go RED then GREEN: when NOT locked the correct PIN
// SUCCEEDS and the KDF runs (proving the denials are real gating, not a blanket reject). Watched red
// during development by forcing the lock (10 failures) before the control's correct attempt → its
// `ok === true` assertion goes red; removed → green.
import { CamelCasePlugin, Kysely } from 'kysely';
import { describe, expect, test } from 'vitest';

import {
  delayMsForFailureCount,
  DomainError,
  PIN_FREE_ATTEMPTS,
  PIN_HARD_LOCK_THRESHOLD,
  PIN_LOCKOUT_SCHEDULE,
  clearPinLockoutFlow,
  readPinAttempt,
  resetPin,
  verifyPin,
} from '@bolusi/core';
import { createClientDialect, type ClientDatabase } from '@bolusi/db-client';

import { FaultFetch } from '../src/fault-fetch.js';
import { openPinFixture, verifyDeps, type PinFixture } from '../src/pin-fixture.js';
import { resolveSeeds, withSeed } from '../src/index.js';

const PIN = '424242';
const WRONG = '000000';

async function expectDomain(p: Promise<unknown>, code: string): Promise<DomainError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError && e.code === code) return e;
    throw new Error(`expected DomainError(${code}), got ${String(e)}`);
  }
  throw new Error(`expected DomainError(${code}), nothing thrown`);
}

/** Advance the FakeClock to the open window's `notBefore`, then submit a wrong PIN (an evaluated failure). */
async function failPastWindow(f: PinFixture, deps: ReturnType<typeof verifyDeps>): Promise<void> {
  const row = await readPinAttempt(f.db, f.staffId, f.deviceId);
  if (row?.notBefore != null && f.clock.now() < row.notBefore) f.clock.set(row.notBefore);
  await verifyPin(deps, { userId: f.staffId, pin: WRONG });
}

describe('CHAOS-11 PIN rate-limit escalation timing', () => {
  for (const seed of resolveSeeds()) {
    test(`CHAOS-11 schedule exact under FakeClock; no KDF during a window; hard lock + both offline recoveries [seed ${seed}]`, async () => {
      await withSeed(
        seed,
        async () => {
          const f = await openPinFixture(seed, { pin: PIN });
          const deps = verifyDeps(f);
          try {
            // ── The free band: PIN_FREE_ATTEMPTS wrong guesses each RUN the KDF (evaluated) ──────────
            for (let i = 0; i < PIN_FREE_ATTEMPTS; i += 1) {
              expect((await verifyPin(deps, { userId: f.staffId, pin: WRONG })).ok).toBe(false);
            }
            expect(f.kdfCalls(), 'the free attempts each ran the KDF').toBe(PIN_FREE_ATTEMPTS);
            const afterFree = await readPinAttempt(f.db, f.staffId, f.deviceId);
            expect(afterFree?.consecutiveFailures).toBe(PIN_FREE_ATTEMPTS);
            // notBefore is EXACTLY now + the schedule's first window — imported, never a literal.
            const firstWindow = delayMsForFailureCount(PIN_FREE_ATTEMPTS);
            expect(firstWindow).toBe(PIN_LOCKOUT_SCHEDULE[0]!.delayMs); // the schedule is the source
            expect(afterFree?.notBefore).toBe(f.clock.now() + firstWindow);

            // ── delay − 1 ms: refused (wrong OR correct PIN), NO KDF ────────────────────────────────
            const kdfBeforeWindow = f.kdfCalls();
            f.clock.set(afterFree!.notBefore! - 1);
            const err = await expectDomain(
              verifyPin(deps, { userId: f.staffId, pin: WRONG }),
              'PIN_RATE_LIMITED',
            );
            expect(err.details).toMatchObject({ retryAt: afterFree!.notBefore });
            await expectDomain(
              verifyPin(deps, { userId: f.staffId, pin: PIN }),
              'PIN_RATE_LIMITED',
            );
            expect(f.kdfCalls(), 'no KDF ran during the delay window').toBe(kdfBeforeWindow);

            // ── at exactly `delay`: evaluated again, count advances ─────────────────────────────────
            f.clock.set(afterFree!.notBefore!);
            expect((await verifyPin(deps, { userId: f.staffId, pin: WRONG })).ok).toBe(false);
            expect(f.kdfCalls()).toBe(kdfBeforeWindow + 1);
            expect((await readPinAttempt(f.db, f.staffId, f.deviceId))?.consecutiveFailures).toBe(
              PIN_FREE_ATTEMPTS + 1,
            );

            // ── drive to the hard lock (10th failure) ───────────────────────────────────────────────
            while (
              (await readPinAttempt(f.db, f.staffId, f.deviceId))!.consecutiveFailures <
              PIN_HARD_LOCK_THRESHOLD
            ) {
              await failPastWindow(f, deps);
            }
            const kdfAtLock = f.kdfCalls();
            const lockOps = (await f.authOps()).filter((o) => o.type === 'auth.pin_locked_out');
            expect(lockOps).toHaveLength(1); // emitted exactly once, at the 10th
            expect(lockOps[0]!.userId).toBe(f.staffId);
            expect(lockOps[0]!.source).toBe('system');
            expect(JSON.parse(lockOps[0]!.payload)).toMatchObject({
              consecutiveFailures: PIN_HARD_LOCK_THRESHOLD,
            });

            // Locked: even the CORRECT PIN throws PIN_LOCKED and the KDF does NOT run (no oracle).
            await expectDomain(verifyPin(deps, { userId: f.staffId, pin: PIN }), 'PIN_LOCKED');
            expect(f.kdfCalls(), 'no KDF while locked_out').toBe(kdfAtLock);

            // ── OFFLINE recovery path 1: owner unlock (auth.clearPinLockout) — ZERO network ─────────
            // The FaultFetch is the §3.6-mandated witness: the recovery flow takes NO transport, so
            // any future regression that made it reach the network would trip a request through this
            // wrapper. `requests` staying empty is the "offline-only (§6.5)" assertion.
            const ff = new FaultFetch(() => Promise.reject(new Error('no transport in recovery')));
            const clear = await clearPinLockoutFlow(f.flowDeps(), {
              actorUserId: f.ownerId,
              targetUserId: f.staffId,
            });
            expect(clear.ops[0]!.status).toBe('appended');
            expect(
              ff.requests,
              'owner unlock makes zero network calls (§6.5 offline-only)',
            ).toHaveLength(0);
            const clearOps = (await f.authOps()).filter(
              (o) => o.type === 'auth.pin_lockout_cleared',
            );
            expect(clearOps).toHaveLength(1);
            // The correct PIN unlocks again (counter reset to 0).
            expect((await verifyPin(deps, { userId: f.staffId, pin: PIN })).ok).toBe(true);
            expect((await readPinAttempt(f.db, f.staffId, f.deviceId))?.consecutiveFailures).toBe(
              0,
            );
          } finally {
            await f.close();
          }
        },
        'CHAOS-11',
      );
    });
  }

  test('CHAOS-11 offline recovery path 2: owner PIN reset clears the lock and invalidates the old PIN (zero network)', async () => {
    const f = await openPinFixture(2, { pin: PIN });
    const deps = verifyDeps(f);
    try {
      // Hard-lock staff.
      while (
        ((await readPinAttempt(f.db, f.staffId, f.deviceId))?.consecutiveFailures ?? 0) <
        PIN_HARD_LOCK_THRESHOLD
      ) {
        await failPastWindow(f, deps);
      }
      await expectDomain(verifyPin(deps, { userId: f.staffId, pin: PIN }), 'PIN_LOCKED');

      const ff = new FaultFetch(() => Promise.reject(new Error('no transport in recovery')));
      const recoveryDeps = f.flowDeps();
      await resetPin(recoveryDeps, {
        actorUserId: f.ownerId,
        targetUserId: f.staffId,
        newPin: '135791',
      });
      expect(
        ff.requests,
        'owner PIN reset makes zero network calls (§6.5 offline-only)',
      ).toHaveLength(0);
      // Load-bearing offline proof: the new verifier is QUEUED for a later online POST but has NOT
      // been sent — recovery already succeeded locally, without any server round-trip (§5.4).
      expect(
        recoveryDeps.queue.size,
        'the verifier POST is pending, not sent — recovery was offline',
      ).toBe(1);

      // The NEW PIN verifies, the OLD PIN does not — the lockout is cleared and the verifier rotated.
      expect((await verifyPin(deps, { userId: f.staffId, pin: '135791' })).ok).toBe(true);
      expect((await verifyPin(deps, { userId: f.staffId, pin: PIN })).ok).toBe(false);
    } finally {
      await f.close();
    }
  });

  test('CHAOS-11 lockout survives a restart (state discard + DB reopen)', async () => {
    const f = await openPinFixture(3, { pin: PIN });
    const deps = verifyDeps(f);
    try {
      for (let i = 0; i < 5; i += 1) await failPastWindow(f, deps);
      const before = await readPinAttempt(f.db, f.staffId, f.deviceId);
      expect(before?.consecutiveFailures).toBe(5);
      expect(before?.notBefore).not.toBeNull();

      // "Restart": a brand-new Kysely handle over the SAME persisted DB — no in-memory state carries.
      const reopened = new Kysely<ClientDatabase>({
        dialect: createClientDialect(f.driver),
        plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
      });
      const after = await readPinAttempt(reopened, f.staffId, f.deviceId);
      expect(after).toEqual(before); // the row stands, byte for byte
      await reopened.destroy();

      // And within the window the next attempt is still refused.
      f.clock.set(before!.notBefore! - 1);
      await expectDomain(verifyPin(deps, { userId: f.staffId, pin: PIN }), 'PIN_RATE_LIMITED');
    } finally {
      await f.close();
    }
  });

  test('CHAOS-11 a FakeClock rollback never shortens the notBefore window', async () => {
    const f = await openPinFixture(4, { pin: PIN });
    const deps = verifyDeps(f);
    try {
      for (let i = 0; i < 5; i += 1) await failPastWindow(f, deps);
      const stored = (await readPinAttempt(f.db, f.staffId, f.deviceId))!.notBefore!;

      f.clock.set(f.clock.now() - 3_600_000); // roll the clock back 1 hour
      const err = await expectDomain(
        verifyPin(deps, { userId: f.staffId, pin: PIN }),
        'PIN_RATE_LIMITED',
      );
      expect(err.details).toMatchObject({ retryAt: stored }); // the stored window wins — NOT recomputed
      expect((await readPinAttempt(f.db, f.staffId, f.deviceId))?.notBefore).toBe(stored);
    } finally {
      await f.close();
    }
  });

  test('CHAOS-11 positive control: the correct PIN SUCCEEDS when not locked and the KDF runs (denials are real gating, not a blanket reject)', async () => {
    const f = await openPinFixture(5, { pin: PIN });
    const deps = verifyDeps(f);
    try {
      const before = f.kdfCalls();
      expect((await verifyPin(deps, { userId: f.staffId, pin: PIN })).ok).toBe(true);
      expect(f.kdfCalls(), 'the correct PIN ran the KDF exactly once').toBe(before + 1);
      // A successful verify resets the counter to 0 (nothing to recover from).
      expect((await readPinAttempt(f.db, f.staffId, f.deviceId))?.consecutiveFailures ?? 0).toBe(0);
    } finally {
      await f.close();
    }
  });

  test('CHAOS-11 a successful PIN before the 10th resets the counter to 0', async () => {
    const f = await openPinFixture(6, { pin: PIN });
    const deps = verifyDeps(f);
    try {
      for (let i = 0; i < 5; i += 1) await failPastWindow(f, deps);
      const row = await readPinAttempt(f.db, f.staffId, f.deviceId);
      f.clock.set(row!.notBefore!); // past the window
      expect((await verifyPin(deps, { userId: f.staffId, pin: PIN })).ok).toBe(true);
      expect((await readPinAttempt(f.db, f.staffId, f.deviceId))?.consecutiveFailures).toBe(0);
    } finally {
      await f.close();
    }
  });
});
