// The memo (02-permissions §6): synchronous evaluation over an event-invalidated snapshot.
//
// The load-bearing assertion in this file is the NEGATIVE one: advancing a FakeClock — by a
// minute, an hour, a day — must never change an answer. A TTL is stale authorization with a
// comforting name, and §6 forbids it outright. A test that only checked "invalidation works" would
// pass just as happily against a 60-second cache.
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  assemblePermissionRegistry,
  PermissionEvaluator,
  type DirectorySnapshot,
  type DirectorySource,
} from '../../src/index.js';
import {
  role,
  ROLE_STAFF,
  STAFF_IDS,
  STORE_A,
  TENANT,
  USER_STAFF,
  V0_MODULES,
  v0Snapshot,
} from './_fixtures.js';

const registry = assemblePermissionRegistry(V0_MODULES);

/** A directory source whose rows a test can mutate between events — the "direct row change". */
class MutableSource implements DirectorySource {
  current: DirectorySnapshot = v0Snapshot();
  loads = 0;
  async load(): Promise<DirectorySnapshot> {
    this.loads += 1;
    return this.current;
  }
}

const staffQuery = {
  userId: USER_STAFF,
  tenantId: TENANT,
  storeId: STORE_A,
  permissionId: 'notes.create',
} as const;

/** Deactivate USER_STAFF directly in the source, as a bundle write would. */
function deactivateStaff(source: MutableSource): void {
  source.current = v0Snapshot({
    users: { [USER_STAFF]: { status: 'deactivated' } },
  });
}

describe('memo (§6)', () => {
  test('evaluation is synchronous — hasPermission returns a value, never a promise', async () => {
    const source = new MutableSource();
    const evaluator = new PermissionEvaluator(registry, source);
    await evaluator.prime();

    const result = evaluator.hasPermission(staffQuery);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toEqual({ allowed: true });
  });

  test('with no invalidation event, a direct directory-row change is NOT observed', async () => {
    const source = new MutableSource();
    const evaluator = new PermissionEvaluator(registry, source);
    await evaluator.prime();
    // T-14b: the fixture allows BEFORE the change — otherwise "still allowed" proves nothing.
    expect(evaluator.hasPermission(staffQuery)).toEqual({ allowed: true });

    deactivateStaff(source);

    // The snapshot is deliberately frozen: only an event drops it (§6).
    expect(evaluator.hasPermission(staffQuery)).toEqual({ allowed: true });
    expect(source.loads).toBe(1);
  });

  test('after a bundle-refresh write → recompute observed', async () => {
    const source = new MutableSource();
    const evaluator = new PermissionEvaluator(registry, source);
    await evaluator.prime();
    expect(evaluator.hasPermission(staffQuery)).toEqual({ allowed: true });

    deactivateStaff(source);
    await evaluator.onBundleRefresh();

    expect(evaluator.hasPermission(staffQuery)).toEqual({
      allowed: false,
      reason: 'user_inactive',
    });
    expect(source.loads).toBe(2);
  });

  test('after a user switch → recompute', async () => {
    const source = new MutableSource();
    const evaluator = new PermissionEvaluator(registry, source);
    await evaluator.prime();
    expect(evaluator.hasPermission(staffQuery)).toEqual({ allowed: true });

    deactivateStaff(source);
    await evaluator.onUserSwitch();

    expect(evaluator.hasPermission(staffQuery)).toEqual({
      allowed: false,
      reason: 'user_inactive',
    });
    expect(source.loads).toBe(2);
  });

  test('§8.5: grow and shrink both recompute — no "grant fast, revoke slow" asymmetry', async () => {
    const source = new MutableSource();
    // Shrink: start with notes.create, remove it.
    source.current = v0Snapshot();
    const evaluator = new PermissionEvaluator(registry, source);
    await evaluator.prime();
    expect(evaluator.hasPermission(staffQuery)).toEqual({ allowed: true });

    source.current = v0Snapshot({
      roles: {
        [ROLE_STAFF]: role(
          'store',
          STAFF_IDS.filter((id) => id !== 'notes.create'),
        ),
      },
    });
    await evaluator.onBundleRefresh();
    expect(evaluator.hasPermission(staffQuery)).toEqual({ allowed: false, reason: 'not_granted' });

    // Grow: put it back.
    source.current = v0Snapshot();
    await evaluator.onBundleRefresh();
    expect(evaluator.hasPermission(staffQuery)).toEqual({ allowed: true });
  });

  test('the effective set is memoized per (userId, storeId) — recomputed once per generation', async () => {
    const source = new MutableSource();
    const evaluator = new PermissionEvaluator(registry, source);
    await evaluator.prime();

    for (const permissionId of STAFF_IDS) {
      evaluator.hasPermission({ ...staffQuery, permissionId });
    }
    // Many permissions, ONE effective-set computation for the (user, store) pair.
    expect(evaluator.stats.computes).toBe(1);

    // A different store is a different key.
    evaluator.hasPermission({ ...staffQuery, storeId: 'store-other' });
    expect(evaluator.stats.computes).toBe(2);

    // An invalidation drops the memo: the next call recomputes.
    await evaluator.onBundleRefresh();
    evaluator.hasPermission(staffQuery);
    expect(evaluator.stats.computes).toBe(3);
    expect(evaluator.stats.generation).toBe(2);
  });

  test('a corrupt row denies without poisoning the memo (a throw is never cached)', async () => {
    const source = new MutableSource();
    source.current = v0Snapshot({
      roles: { [ROLE_STAFF]: { scopeType: 'store', permissionIdsJson: '["notes.create"' } },
    });
    const evaluator = new PermissionEvaluator(registry, source);
    await evaluator.prime();

    expect(evaluator.hasPermission(staffQuery)).toEqual({
      allowed: false,
      reason: 'evaluation_error',
    });
    // Still denies on the second call, and still has not cached anything.
    expect(evaluator.hasPermission(staffQuery)).toEqual({
      allowed: false,
      reason: 'evaluation_error',
    });
    expect(evaluator.stats.computes).toBe(0);
  });

  test('an unprimed evaluator denies every check — it never allows what it cannot see', () => {
    const evaluator = new PermissionEvaluator(registry, new MutableSource());
    expect(evaluator.isPrimed).toBe(false);
    expect(evaluator.hasPermission(staffQuery)).toEqual({
      allowed: false,
      reason: 'evaluation_error',
    });
  });

  test('a failed refresh leaves the previous snapshot standing — it does not blank authorization', async () => {
    const source = new MutableSource();
    const evaluator = new PermissionEvaluator(registry, source);
    await evaluator.prime();
    expect(evaluator.hasPermission(staffQuery)).toEqual({ allowed: true });

    const failing: DirectorySource = {
      load: () => Promise.reject(new Error('bundle refresh failed')),
    };
    const evaluator2 = new PermissionEvaluator(registry, failing);
    await expect(evaluator2.prime()).rejects.toThrow('bundle refresh failed');
    // An unprimed evaluator denies (fail closed) rather than allowing.
    expect(evaluator2.hasPermission(staffQuery)).toEqual({
      allowed: false,
      reason: 'evaluation_error',
    });

    // And on an already-primed evaluator, a failing refresh keeps the old (stale but correct)
    // answers rather than denying everyone.
    const flaky = new MutableSource();
    const evaluator3 = new PermissionEvaluator(registry, flaky);
    await evaluator3.prime();
    flaky.load = () => Promise.reject(new Error('offline'));
    await expect(evaluator3.onBundleRefresh()).rejects.toThrow('offline');
    expect(evaluator3.hasPermission(staffQuery)).toEqual({ allowed: true });
  });
});

describe('no TTL, ever (§6 — the rule this module exists to keep)', () => {
  test('advancing a FakeClock alone never invalidates and never changes an answer', async () => {
    const source = new MutableSource();
    const evaluator = new PermissionEvaluator(registry, source);
    await evaluator.prime();
    expect(evaluator.hasPermission(staffQuery)).toEqual({ allowed: true });

    // The row changes underneath, with no event. A TTL cache would eventually pick this up; an
    // event-driven memo never does. That difference is the whole point of §6.
    deactivateStaff(source);

    for (const elapsed of [1_000, 60_000, 5 * 60_000, 60 * 60_000, 24 * 60 * 60_000]) {
      void elapsed; // there is no clock to advance — that IS the assertion
      expect(evaluator.hasPermission(staffQuery)).toEqual({ allowed: true });
    }
    expect(source.loads).toBe(1);
    expect(evaluator.stats.generation).toBe(1);
  });

  test('the module contains no clock, no timer, and no expiry (source-level, T-14 denominator)', () => {
    const sources = ['memo.ts', 'evaluate.ts', 'registry.ts', 'directory.ts', 'invalidation.ts'];
    // The denominator: a typo'd path list would read zero files and report green.
    expect(sources).toHaveLength(5);
    for (const name of sources) {
      const path = new URL(`../../src/authz/${name}`, import.meta.url);
      const text = readFileSync(path, 'utf8');
      expect(text.length, `${name} is empty`).toBeGreaterThan(0);
      // Code only — comments legitimately discuss the ban (this file's own header does).
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');
      for (const banned of [
        'Date.now',
        'setTimeout',
        'setInterval',
        'performance.now',
        'expiresAt',
        'ttl',
        'TTL',
      ]) {
        expect(code.includes(banned), `${name} must not contain ${banned} (§6: never TTL)`).toBe(
          false,
        );
      }
    }
  });
});
