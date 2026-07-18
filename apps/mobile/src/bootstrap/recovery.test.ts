// The boot-time self-heal for an unreadable local DB (security-guide §6.6; task 91).
//
// This file unit-verifies the HEAL LOGIC against the `DbOpenError` kinds — the leg the task
// acceptance says is verifiable here. What it CANNOT verify (stated plainly, T-11/D12/D13): that a
// real iPhone restore produces this exact sequence. No iOS hardware or Simulator exists on this
// infrastructure (task 85), and better-sqlite3 has no SQLCipher build, so a genuine wrong-key
// SQLCipher rejection is never produced anywhere in the Node lane. The `DbOpenError` shapes below
// are constructed to MATCH `connection.ts`'s `sanitizeOpenFailure` producer verbatim (its message is
// `failed to open the client database: <native msg>`, and SQLCipher's native msg for a wrong key is
// "file is not a database"); `test/bootstrap.test.ts` pins that they are the shape the REAL
// `openClientDb` emits (T-16: trace to the producer, don't assert against a hand-built lookalike).
import { DbError, DbOpenError } from '@bolusi/db-client';
import { describe, expect, test, vi } from 'vitest';

import type { Bootstrapped } from './bootstrap.js';
import { bootWithLocalRecovery, isUnrecoverableLocalDbError } from './recovery.js';

/** The exact message `sanitizeOpenFailure` builds around a native error (connection.ts). */
function driverOpenFailed(nativeMessage: string, cause?: unknown): DbOpenError {
  return new DbOpenError(
    'driver_open_failed',
    `failed to open the client database: ${nativeMessage}`,
    cause === undefined ? undefined : { cause },
  );
}

/** A booted app stand-in: only `deviceId` is read by the recovery + these tests. */
function fakeApp(deviceId: string | null): Bootstrapped {
  return { deviceId } as unknown as Bootstrapped;
}

describe('isUnrecoverableLocalDbError — the wrong-key/orphan class heals, everything else surfaces', () => {
  test('HEALS a wrong-key open: driver_open_failed carrying SQLCipher’s not-a-database text', () => {
    // The restore case. Both SQLCipher phrasings must count (driver.ts’s pattern accepts either).
    expect(isUnrecoverableLocalDbError(driverOpenFailed('file is not a database'))).toBe(true);
    expect(
      isUnrecoverableLocalDbError(driverOpenFailed('file is encrypted or is not a database')),
    ).toBe(true);
  });

  test('HEALS when the not-a-database text is on the CAUSE, not the top message', () => {
    // `sanitizeOpenFailure` puts the phrase on both; classify the cause too so a future re-wrap that
    // moved it cannot silently downgrade a wrong-key open to "surface".
    const err = driverOpenFailed(
      'generic wrapper text',
      new DbError('not_a_database', 'file is not a database'),
    );
    expect(isUnrecoverableLocalDbError(err)).toBe(true);
  });

  test('HEALS a missing_key open — the DB, if present, is unreadable ciphertext', () => {
    expect(
      isUnrecoverableLocalDbError(new DbOpenError('missing_key', 'no SQLCipher key available')),
    ).toBe(true);
  });

  test('SURFACES a transient I/O open failure — the fail-safe that must never wipe a good DB', () => {
    // Same `driver_open_failed` code as the wrong-key case, but NOT the not-a-database symptom.
    // Classifying on the code alone would wipe a healthy DB on a flaky open (task acceptance).
    expect(isUnrecoverableLocalDbError(driverOpenFailed('disk I/O error'))).toBe(false);
    expect(isUnrecoverableLocalDbError(driverOpenFailed('unable to open database file'))).toBe(
      false,
    );
    expect(isUnrecoverableLocalDbError(driverOpenFailed('database is locked'))).toBe(false);
  });

  test('SURFACES already_open / not_open — lifecycle bugs, not an unreadable file', () => {
    expect(
      isUnrecoverableLocalDbError(new DbOpenError('already_open', 'a connection is open')),
    ).toBe(false);
    expect(isUnrecoverableLocalDbError(new DbOpenError('not_open', 'nothing is open'))).toBe(false);
  });

  test('SURFACES a non-DbOpenError even if it MENTIONS not-a-database — a wipe needs the real kind', () => {
    // A migration/registration/keystore throw that happens to contain the phrase must NOT trigger a
    // wipe: the classifier requires the DbOpenError kind, not a substring match on any error (T-16 —
    // a mention is not the producer). Also covers the plain non-Error and null cases.
    expect(isUnrecoverableLocalDbError(new Error('file is not a database'))).toBe(false);
    expect(
      isUnrecoverableLocalDbError(new DbError('not_a_database', 'file is not a database')),
    ).toBe(false);
    expect(isUnrecoverableLocalDbError('file is not a database')).toBe(false);
    expect(isUnrecoverableLocalDbError(null)).toBe(false);
  });
});

describe('bootWithLocalRecovery — heal once, never loop, never wipe on transient', () => {
  test('a wrong-key boot WIPES ONCE and re-boots into a fresh, unenrolled app (the recovery)', async () => {
    const order: string[] = [];
    const fresh = fakeApp(null);
    const boot = vi
      .fn<() => Promise<Bootstrapped>>()
      .mockImplementationOnce(() => {
        order.push('boot-1');
        return Promise.reject(driverOpenFailed('file is not a database'));
      })
      .mockImplementationOnce(() => {
        order.push('boot-2');
        return Promise.resolve(fresh);
      });
    const wipeLocalData = vi.fn(async () => {
      order.push('wipe');
    });

    const app = await bootWithLocalRecovery({ boot, wipeLocalData });

    // Recovered to the FRESH booted app (deviceId null → enrollment wizard via the gate), not blank.
    expect(app).toBe(fresh);
    expect(app.deviceId).toBeNull();
    expect(wipeLocalData).toHaveBeenCalledTimes(1);
    expect(boot).toHaveBeenCalledTimes(2);
    // The wipe happens BETWEEN the two boots — a re-boot before the wipe would open the same
    // unreadable file again.
    expect(order).toStrictEqual(['boot-1', 'wipe', 'boot-2']);
  });

  test('a TRANSIENT boot failure does NOT wipe and surfaces unchanged (fail-safe: a flaky open must not destroy a good DB)', async () => {
    const transient = driverOpenFailed('disk I/O error');
    const boot = vi.fn<() => Promise<Bootstrapped>>().mockRejectedValue(transient);
    const wipeLocalData = vi.fn(async () => undefined);

    await expect(bootWithLocalRecovery({ boot, wipeLocalData })).rejects.toBe(transient);
    expect(wipeLocalData).not.toHaveBeenCalled();
    expect(boot).toHaveBeenCalledTimes(1);
  });

  test('a non-DbOpenError boot failure does NOT wipe and surfaces unchanged', async () => {
    const other = new Error('module registration failed');
    const boot = vi.fn<() => Promise<Bootstrapped>>().mockRejectedValue(other);
    const wipeLocalData = vi.fn(async () => undefined);

    await expect(bootWithLocalRecovery({ boot, wipeLocalData })).rejects.toBe(other);
    expect(wipeLocalData).not.toHaveBeenCalled();
  });

  test('a healthy boot returns without wiping (positive control — the catch does not swallow a good open)', async () => {
    const good = fakeApp('device-abc');
    const boot = vi.fn<() => Promise<Bootstrapped>>().mockResolvedValue(good);
    const wipeLocalData = vi.fn(async () => undefined);

    const app = await bootWithLocalRecovery({ boot, wipeLocalData });

    expect(app).toBe(good);
    expect(wipeLocalData).not.toHaveBeenCalled();
    expect(boot).toHaveBeenCalledTimes(1);
  });

  test('DOES NOT LOOP: a wrong-key boot that STILL fails after the wipe surfaces, wiping only once', async () => {
    // A wipe that could not produce a bootable DB must not run forever (task acceptance: "do not
    // loop"). At most one wipe + one retry; the second failure propagates.
    const secondFailure = driverOpenFailed('file is not a database');
    const boot = vi
      .fn<() => Promise<Bootstrapped>>()
      .mockRejectedValueOnce(driverOpenFailed('file is not a database'))
      .mockRejectedValueOnce(secondFailure);
    const wipeLocalData = vi.fn(async () => undefined);

    await expect(bootWithLocalRecovery({ boot, wipeLocalData })).rejects.toBe(secondFailure);
    expect(wipeLocalData).toHaveBeenCalledTimes(1);
    expect(boot).toHaveBeenCalledTimes(2);
  });
});
