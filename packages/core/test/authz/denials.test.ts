// Denial emission + throttle (02-permissions §7), on a FakeClock (testing-guide §3.3 / T-6).
//
// No test here sleeps or reads a real clock: the 5-minute window is exercised by ADVANCING an
// injected clock, so the boundary cases are exact rather than approximately timed.
import { describe, expect, test } from 'vitest';

import {
  assemblePermissionRegistry,
  DenialEmitter,
  DENIAL_THROTTLE_WINDOW_MS,
  isPermissionDeniedPayload,
  PermissionEvaluator,
  PERMISSION_DENIED_OP_TYPE,
  PERMISSION_DENIAL_ENTITY_TYPE,
  type DenialAttempt,
  type DenialEmissionContext,
  type DenialEmissionPort,
  type PermissionDeniedPayload,
} from '../../src/index.js';
import { STORE_A, TENANT, USER_STAFF, V0_MODULES, v0Snapshot } from './_fixtures.js';

interface Emission {
  readonly payload: PermissionDeniedPayload;
  readonly context: DenialEmissionContext;
}

class RecordingPort implements DenialEmissionPort {
  readonly emissions: Emission[] = [];
  emit(payload: PermissionDeniedPayload, context: DenialEmissionContext): void {
    this.emissions.push({ payload, context });
  }
}

function makeFakeClock(startMs: number) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

const BASE: DenialAttempt = {
  userId: USER_STAFF,
  permissionId: 'auth.user_create',
  surface: 'command',
  target: 'createUser',
  reason: 'not_granted',
  scopeStoreId: STORE_A,
  source: 'user',
  agentInitiated: false,
};

function setup(startMs = 1_700_000_000_000) {
  const clock = makeFakeClock(startMs);
  const port = new RecordingPort();
  const emitter = new DenialEmitter(port, { now: clock.now });
  return { clock, port, emitter };
}

describe('denial payload (§7)', () => {
  test('the op type and entityType are the §7/§4 constants', () => {
    expect(PERMISSION_DENIED_OP_TYPE).toBe('auth.permission_denied');
    expect(PERMISSION_DENIAL_ENTITY_TYPE).toBe('permission_denial');
  });

  test('a first denial emits exactly one payload with ALL keys present and suppressedRepeats: 0', async () => {
    const { port, emitter } = setup();
    const payload = await emitter.record(BASE);

    expect(port.emissions).toHaveLength(1);
    expect(payload).toEqual({
      permissionId: 'auth.user_create',
      surface: 'command',
      target: 'createUser',
      reason: 'not_granted',
      scopeStoreId: STORE_A,
      suppressedRepeats: 0,
    });
    // "All keys always present" is the §7 contract — assert the exact key SET, so a future
    // optional-key refactor cannot quietly drop one.
    expect(Object.keys(port.emissions[0]!.payload).sort()).toEqual([
      'permissionId',
      'reason',
      'scopeStoreId',
      'suppressedRepeats',
      'surface',
      'target',
    ]);
  });

  test('scopeStoreId is null for a tenant-scope check — present, not absent', async () => {
    const { port, emitter } = setup();
    await emitter.record({ ...BASE, permissionId: 'auth.role_manage', scopeStoreId: null });

    const payload = port.emissions[0]!.payload;
    expect(payload.scopeStoreId).toBeNull();
    expect('scopeStoreId' in payload).toBe(true);
  });

  test('the payload validates against the shape contract', async () => {
    const { port, emitter } = setup();
    await emitter.record(BASE);
    await emitter.record({ ...BASE, surface: 'query', target: 'listUsers', scopeStoreId: null });
    expect(port.emissions).toHaveLength(2); // denominator before the loop (T-14)
    for (const { payload } of port.emissions) {
      expect(isPermissionDeniedPayload(payload)).toBe(true);
    }
  });

  test('the shape check rejects a payload missing any key (the missing-key class, T-12)', () => {
    const complete: PermissionDeniedPayload = {
      permissionId: 'notes.create',
      surface: 'command',
      target: 'createNote',
      reason: 'not_granted',
      scopeStoreId: null,
      suppressedRepeats: 0,
    };
    expect(isPermissionDeniedPayload(complete)).toBe(true);

    const keys = Object.keys(complete);
    expect(keys).toHaveLength(6); // the class's denominator
    for (const key of keys) {
      const partial: Record<string, unknown> = { ...complete };
      delete partial[key];
      expect(isPermissionDeniedPayload(partial), `missing ${key} must be rejected`).toBe(false);
    }
    // And rejects the bad-value class.
    expect(isPermissionDeniedPayload({ ...complete, surface: 'screen' })).toBe(false);
    expect(isPermissionDeniedPayload({ ...complete, suppressedRepeats: -1 })).toBe(false);
    expect(isPermissionDeniedPayload({ ...complete, suppressedRepeats: 1.5 })).toBe(false);
    expect(isPermissionDeniedPayload({ ...complete, scopeStoreId: 42 })).toBe(false);
    expect(isPermissionDeniedPayload({ ...complete, extra: true })).toBe(false);
    expect(isPermissionDeniedPayload(null)).toBe(false);
  });

  test('source / agentInitiated mirror the denied attempt — a denied agent attempt is visible as one', async () => {
    const { port, emitter } = setup();
    await emitter.record({
      ...BASE,
      source: 'agent',
      agentInitiated: true,
      agentConversationId: 'conv-1',
    });
    expect(port.emissions[0]!.context).toEqual({
      userId: USER_STAFF,
      source: 'agent',
      agentInitiated: true,
      agentConversationId: 'conv-1',
    });
  });
});

describe('throttle (§7 — one op per (userId, permissionId, target) per 5 minutes)', () => {
  test('the window is 5 minutes', () => {
    expect(DENIAL_THROTTLE_WINDOW_MS).toBe(5 * 60 * 1000);
  });

  test('repeats inside the window emit nothing and are counted', async () => {
    const { clock, port, emitter } = setup();
    await emitter.record(BASE);
    expect(port.emissions).toHaveLength(1);

    for (let i = 0; i < 4; i += 1) {
      clock.advance(30_000);
      expect(await emitter.record(BASE)).toBeNull();
    }
    expect(port.emissions).toHaveLength(1);
    expect(emitter.suppressedCount(BASE.userId, BASE.permissionId, BASE.target)).toBe(4);
  });

  test('the first emission after the window carries suppressedRepeats = N', async () => {
    const { clock, port, emitter } = setup();
    await emitter.record(BASE);
    for (let i = 0; i < 7; i += 1) {
      clock.advance(10_000);
      await emitter.record(BASE);
    }
    expect(port.emissions).toHaveLength(1);

    clock.advance(DENIAL_THROTTLE_WINDOW_MS);
    const payload = await emitter.record(BASE);

    expect(port.emissions).toHaveLength(2);
    expect(payload?.suppressedRepeats).toBe(7);
    // The counter resets with the new window.
    expect(emitter.suppressedCount(BASE.userId, BASE.permissionId, BASE.target)).toBe(0);
  });

  test('the window boundary is exact: < window suppresses, >= window emits', async () => {
    const { clock, port, emitter } = setup();
    await emitter.record(BASE);

    clock.advance(DENIAL_THROTTLE_WINDOW_MS - 1);
    expect(await emitter.record(BASE)).toBeNull();
    expect(port.emissions).toHaveLength(1);

    clock.advance(1); // now exactly at the window
    expect(await emitter.record(BASE)).not.toBeNull();
    expect(port.emissions).toHaveLength(2);
  });

  test('distinct tuples throttle independently (the tuple class, T-12)', async () => {
    const { port, emitter } = setup();
    // Each variant differs from BASE in exactly ONE key of the (userId, permissionId, target)
    // throttle key — the whole class, not one remembered example.
    const variants: DenialAttempt[] = [
      BASE,
      { ...BASE, userId: 'user-other' },
      { ...BASE, permissionId: 'auth.user_edit' },
      { ...BASE, target: 'editUser' },
    ];
    for (const variant of variants) await emitter.record(variant);

    expect(port.emissions).toHaveLength(variants.length);
    expect(emitter.trackedTuples).toBe(variants.length);

    // ...and each throttles its own repeat.
    for (const variant of variants) expect(await emitter.record(variant)).toBeNull();
    expect(port.emissions).toHaveLength(variants.length);
  });

  test('reason and scopeStoreId are NOT part of the throttle key — the tuple is what §7 says', async () => {
    const { port, emitter } = setup();
    await emitter.record(BASE);
    // Same (userId, permissionId, target), different reason/scope → still one op per window.
    expect(
      await emitter.record({ ...BASE, reason: 'missing_scope', scopeStoreId: null }),
    ).toBeNull();
    expect(port.emissions).toHaveLength(1);
  });

  test('counter state is memory-only — a simulated restart resets it (§7, accepted)', async () => {
    const { clock, port, emitter } = setup();
    await emitter.record(BASE);
    clock.advance(1_000);
    await emitter.record(BASE);
    expect(emitter.suppressedCount(BASE.userId, BASE.permissionId, BASE.target)).toBe(1);

    // Restart: a fresh emitter over the same port and clock, as an app relaunch would build.
    const restarted = new DenialEmitter(port, { now: clock.now });
    expect(restarted.trackedTuples).toBe(0);
    clock.advance(1_000);
    const payload = await restarted.record(BASE);
    // The signal is the pattern, not the exact count: the suppressed repeats from before the
    // restart are gone, and the denial emits immediately rather than being wrongly suppressed.
    expect(payload?.suppressedRepeats).toBe(0);
    expect(port.emissions).toHaveLength(2);
  });
});

describe('emission is never permission-checked (§7 — no recursion)', () => {
  test('the emitter holds no evaluator and never re-enters one', async () => {
    const registry = assemblePermissionRegistry(V0_MODULES);
    let evaluations = 0;
    const evaluator = new PermissionEvaluator(registry, {
      load: async () => v0Snapshot(),
    });
    await evaluator.prime();
    const realHasPermission = evaluator.hasPermission.bind(evaluator);
    evaluator.hasPermission = (query) => {
      evaluations += 1;
      return realHasPermission(query);
    };

    // Sanity (T-14b): the counter DOES move when the evaluator is genuinely called — otherwise
    // "0 evaluations" below would prove only that the probe is broken.
    evaluator.hasPermission({
      userId: USER_STAFF,
      tenantId: TENANT,
      storeId: STORE_A,
      permissionId: 'notes.create',
    });
    expect(evaluations).toBe(1);

    const { emitter, port } = setup();
    await emitter.record(BASE);
    await emitter.record({ ...BASE, target: 'other' });

    expect(port.emissions).toHaveLength(2);
    // A denial log must not itself be deniable: emission does not consult the evaluator at all.
    expect(evaluations).toBe(1);
  });

  test('the emitter emits regardless of the acting user’s state — even a deactivated one', async () => {
    const { port, emitter } = setup();
    // A deactivated user's denial (reason user_inactive) still records: authentication precedes
    // authorization, and the audit trail is the point.
    await emitter.record({ ...BASE, reason: 'user_inactive' });
    expect(port.emissions).toHaveLength(1);
    expect(port.emissions[0]!.payload.reason).toBe('user_inactive');
  });
});
