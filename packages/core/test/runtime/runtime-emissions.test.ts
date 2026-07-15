// The five sanctioned runtime emissions (04-module-contract §5.1; 02-permissions §4).
//
// THE SET IS THE ASSERTION (testing-guide T-14). A suite that checks "these five are allowed" is
// green whether the channel permits five types or five hundred — the interesting question is the
// DENOMINATOR: is anything else appendable outside a command? So this file pins exact membership
// and exact size, and drives the rejection side from a list of things that must NOT get through.
import { describe, expect, it } from 'vitest';

import type { SignedOperation } from '@bolusi/schemas';

import {
  isSanctionedRuntimeEmission,
  RuntimeEmissionError,
  SANCTIONED_RUNTIME_EMISSION_TYPES,
} from '../../src/index.js';

import { makeRuntimeFixture, type RuntimeFixture } from './_fixtures.js';

async function ready(seed: number) {
  const fixture = makeRuntimeFixture(seed);
  await fixture.prime();
  return fixture;
}

function allOps(fixture: RuntimeFixture): SignedOperation[] {
  return fixture.store.forDevice(fixture.deviceId).map((row) => row.op);
}

describe('the sanctioned set is CLOSED (04 §5.1)', () => {
  it('is exactly these five types — no more, no fewer', () => {
    // Pinned as a SET, verbatim from 04 §5.1 / 02 §4. A sixth type added to the constant fails
    // here, which is the entire point: the runtime bypassing the only write path is not something
    // that should be possible to do quietly.
    expect([...SANCTIONED_RUNTIME_EMISSION_TYPES].sort()).toEqual([
      'auth.device_enrolled',
      'auth.permission_denied',
      'auth.pin_locked_out',
      'auth.session_ended',
      'auth.user_switched',
    ]);
    expect(SANCTIONED_RUNTIME_EMISSION_TYPES).toHaveLength(5);
  });

  it('every sanctioned type is an `auth.*` type', () => {
    // Each exemption exists because authentication precedes authorization, or because the record
    // must not depend on the permissions of the user it is about (02 §4). Both are auth concerns;
    // a business-module type appearing here would have no such justification.
    for (const type of SANCTIONED_RUNTIME_EMISSION_TYPES) {
      expect(type.startsWith('auth.')).toBe(true);
    }
  });

  it('the membership predicate agrees with the constant, over the whole set', () => {
    for (const type of SANCTIONED_RUNTIME_EMISSION_TYPES) {
      expect(isSanctionedRuntimeEmission(type)).toBe(true);
    }
  });

  it.each([
    'notes.note_created',
    'notes.note_body_edited',
    'auth.pin_changed',
    'auth.pin_reset',
    'auth.user_created',
    'auth.device_revoked',
    'platform.user_locale_changed',
    'auth.permission_granted',
    'auth.session_started',
    'AUTH.USER_SWITCHED',
    'auth.user_switched ',
    'auth.user_switched.extra',
    '',
  ])('rejects %j — deny by allowlist, not by blocklist', (type) => {
    // Near-misses are deliberate: casing, a trailing space, a suffix, and the plausible-sounding
    // `auth.*` types that are NOT exempt. A blocklist would pass every one of these.
    expect(isSanctionedRuntimeEmission(type)).toBe(false);
  });
});

describe('the emission channel (04 §5.1)', () => {
  it.each([...SANCTIONED_RUNTIME_EMISSION_TYPES].filter((t) => t !== 'auth.device_enrolled'))(
    'appends %s without a command and without a permission check',
    async (type) => {
      const fixture = await ready(1);
      // `auth.device_enrolled` must be the device's FIRST op (05 §9.5), so enroll first and let
      // the other four ride a live chain — its own case is below.
      await fixture.enroll();

      await fixture.runtime.emitRuntimeOp({
        type,
        entityType: 'session',
        entityId: fixture.newId(),
        payload: { note: `emission-${type}` },
        userId: fixture.staffId,
      });

      const ops = allOps(fixture).filter((op) => op.type === type);
      expect(ops, `${type} must append`).toHaveLength(1);
      expect(fixture.evaluator.checks, 'exempt from the check by design (02 §4)').toEqual([]);
      expect(fixture.log.count('handler'), 'no handler is involved').toBe(0);
    },
  );

  it('appends auth.device_enrolled as the genesis op, before any directory exists (02 §6)', async () => {
    // The bootstrap case: emitted BEFORE the bundle is written into the directory tables, so the
    // evaluator is not even primed. An exemption that required a primed evaluator would be no
    // exemption at all.
    const fixture = makeRuntimeFixture(2);

    await fixture.runtime.emitRuntimeOp({
      type: 'auth.device_enrolled',
      entityType: 'device',
      entityId: fixture.deviceId,
      payload: { enrolledDeviceId: fixture.deviceId },
      userId: fixture.ownerId,
    });

    const ops = allOps(fixture);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.seq, 'genesis is seq 1 (05 §2.1)').toBe(1);
    expect(ops[0]!.previousHash).toBe('0'.repeat(64));
    expect(fixture.evaluator.isPrimed, 'no directory needed to enroll').toBe(false);
  });

  it('a sixth type throws and appends NOTHING', async () => {
    const fixture = await ready(3);
    await fixture.enroll();
    const before = allOps(fixture).length;

    const error = await fixture.runtime
      .emitRuntimeOp({
        type: 'notes.note_created' as never,
        entityType: 'note',
        entityId: fixture.newId(),
        payload: { title: 'smuggled', body: 'through the runtime channel' },
        userId: fixture.ownerId,
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RuntimeEmissionError);
    expect((error as RuntimeEmissionError).type).toBe('notes.note_created');
    expect(allOps(fixture), 'a rejected type leaves the log untouched').toHaveLength(before);
    expect(fixture.scheduler.calls, 'and schedules no sync').toBe(0);
  });

  it('the rejection happens before the store is touched, not after a rollback', async () => {
    const fixture = await ready(4);
    await fixture.enroll();

    await fixture.runtime
      .emitRuntimeOp({
        type: 'platform.user_locale_changed' as never,
        entityType: 'user',
        entityId: fixture.newId(),
        payload: {},
        userId: fixture.ownerId,
      })
      .catch(() => undefined);

    // No projection apply was attempted: the type gate runs before any transaction opens.
    expect(fixture.projected).toEqual([]);
  });

  it('POSITIVE CONTROL — the channel does work, so the rejection above is not blanket (T-14b)', async () => {
    const fixture = await ready(5);
    await fixture.enroll();

    await expect(
      fixture.runtime.emitRuntimeOp({
        type: 'auth.pin_locked_out',
        entityType: 'user',
        entityId: fixture.newId(),
        payload: { consecutiveFailures: 10, windowStartedAt: fixture.clock.now() },
        userId: fixture.staffId,
      }),
    ).resolves.toBeDefined();

    expect(allOps(fixture).filter((op) => op.type === 'auth.pin_locked_out')).toHaveLength(1);
  });

  it('a lockout op is attributed to the locked-out user, not to the caller (api/02-auth §6.5)', async () => {
    const fixture = await ready(6);
    await fixture.enroll();

    await fixture.runtime.emitRuntimeOp({
      type: 'auth.pin_locked_out',
      entityType: 'user',
      entityId: fixture.newId(),
      payload: { consecutiveFailures: 10, windowStartedAt: fixture.clock.now() },
      userId: fixture.staffId,
    });

    const op = allOps(fixture).filter((o) => o.type === 'auth.pin_locked_out')[0]!;
    expect(op.userId).toBe(fixture.staffId);
    expect(op.source, 'runtime emissions default to system attribution').toBe('system');
  });

  it('emitted ops carry the full §2.1 envelope and are projected + sync-scheduled', async () => {
    const fixture = await ready(7);
    await fixture.enroll();

    await fixture.runtime.emitRuntimeOp({
      type: 'auth.session_ended',
      entityType: 'session',
      entityId: fixture.newId(),
      payload: { reason: 'idle_lock' },
      userId: fixture.ownerId,
    });

    const op = allOps(fixture).filter((o) => o.type === 'auth.session_ended')[0]!;
    expect(op.tenantId).toBe(fixture.tenantId);
    expect(op.deviceId).toBe(fixture.deviceId);
    expect(op.agentInitiated).toBe(false);
    expect(op.agentConversationId).toBeNull();
    expect(fixture.projected.map((op) => op.type)).toContain('auth.session_ended');
    expect(fixture.scheduler.calls).toBe(1);
  });
});
