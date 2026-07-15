// Permission-set-change invalidation hooks (02-permissions §8.4–§8.5).
import { describe, expect, test } from 'vitest';

import { permissionSetDelta, PermissionInvalidationRegistry } from '../../src/index.js';

describe('permissionSetDelta (§8.5)', () => {
  test('reports grow AND shrink — the symmetric difference', () => {
    const before = new Set(['notes.create', 'notes.edit']);
    const after = new Set(['notes.edit', 'notes.archive']);
    expect([...permissionSetDelta(before, after)].sort()).toEqual([
      'notes.archive',
      'notes.create',
    ]);
  });

  test('an unchanged set has an empty delta', () => {
    const set = new Set(['notes.create']);
    expect(permissionSetDelta(set, new Set(set)).size).toBe(0);
  });

  test('a pure revoke is a change — this is the "revoke slow" asymmetry §8.5 rules out', () => {
    const delta = permissionSetDelta(new Set(['auth.role_manage']), new Set());
    expect([...delta]).toEqual(['auth.role_manage']);
  });

  test('a pure grant is a change', () => {
    const delta = permissionSetDelta(new Set(), new Set(['auth.role_manage']));
    expect([...delta]).toEqual(['auth.role_manage']);
  });
});

describe('hook registry (§8.4)', () => {
  test('fires a hook when a change touches its declared ids, on GROW', () => {
    const registry = new PermissionInvalidationRegistry();
    const fired: ReadonlySet<string>[] = [];
    registry.register(['notes.read'], (changed) => fired.push(changed));

    registry.notifyChange(new Set(), new Set(['notes.read']));

    expect(fired).toHaveLength(1);
    expect([...fired[0]!]).toEqual(['notes.read']);
  });

  test('fires the same hook on SHRINK (§8.5 — both, symmetrically)', () => {
    const registry = new PermissionInvalidationRegistry();
    let fired = 0;
    registry.register(['notes.read'], () => {
      fired += 1;
    });

    registry.notifyChange(new Set(['notes.read']), new Set());
    expect(fired).toBe(1);

    // And a grow of the same id fires it again — one mechanism, both directions.
    registry.notifyChange(new Set(), new Set(['notes.read']));
    expect(fired).toBe(2);
  });

  test('unrelated changes do not fire it', () => {
    const registry = new PermissionInvalidationRegistry();
    let fired = 0;
    registry.register(['notes.read'], () => {
      fired += 1;
    });

    // T-14b: the hook DOES fire for its own id — so "0" below is silence, not a dead hook.
    registry.notifyChange(new Set(), new Set(['notes.read']));
    expect(fired).toBe(1);

    registry.notifyChange(new Set(['auth.audit_view']), new Set(['platform.conflict_view']));
    expect(fired).toBe(1);
  });

  test('an empty delta is a no-op', () => {
    const registry = new PermissionInvalidationRegistry();
    let fired = 0;
    registry.register(['notes.read'], () => {
      fired += 1;
    });
    registry.notify(new Set());
    registry.notifyChange(new Set(['notes.read']), new Set(['notes.read']));
    expect(fired).toBe(0);
  });

  test('fires every hook whose ids intersect — and only those', () => {
    const registry = new PermissionInvalidationRegistry();
    const fired: string[] = [];
    registry.register(['notes.read'], () => fired.push('notes-cache'));
    registry.register(['notes.read', 'auth.audit_view'], () => fired.push('audit-cache'));
    registry.register(['platform.conflict_view'], () => fired.push('conflict-cache'));

    expect(registry.size).toBe(3); // denominator (T-14)
    registry.notify(new Set(['notes.read']));

    expect(fired.sort()).toEqual(['audit-cache', 'notes-cache']);
  });

  test('unregister stops delivery', () => {
    const registry = new PermissionInvalidationRegistry();
    let fired = 0;
    const off = registry.register(['notes.read'], () => {
      fired += 1;
    });
    registry.notify(new Set(['notes.read']));
    expect(fired).toBe(1);

    off();
    expect(registry.size).toBe(0);
    registry.notify(new Set(['notes.read']));
    expect(fired).toBe(1);
  });

  test('registering with no permission ids is a programming error', () => {
    const registry = new PermissionInvalidationRegistry();
    // A hook that can never fire reads as coverage while providing none — §8.4's requirement is
    // that the cache declares what it depends on.
    expect(() => registry.register([], () => {})).toThrow(/at least one permission id/);
    expect(registry.size).toBe(0);
  });
});
