import { describe, expect, test } from 'vitest';

import { lockedTargets, ownerListState, type PinTargetUser } from './pin-target.js';

const LOCKED: PinTargetUser = { id: 'a', name: 'Ani', lockedOut: true };
const OPEN: PinTargetUser = { id: 'b', name: 'Budi', lockedOut: false };

describe('lockedTargets', () => {
  test('keeps only locked users and returns a fresh array (never the caller’s)', () => {
    const users = [LOCKED, OPEN];
    const result = lockedTargets(users);
    expect(result).toEqual([LOCKED]);
    expect(result).not.toBe(users);
  });

  test('empty when nobody is locked', () => {
    expect(lockedTargets([OPEN])).toEqual([]);
  });
});

describe('ownerListState — the shared §5 precedence for both owner screens', () => {
  test('permission is checked FIRST — denial wins over loading, error, AND a non-empty list', () => {
    // The single guard both owner screens rely on: a caller who lacks the permission can never be
    // routed to loading/error/ready, so no target list (or "nothing here") ever leaks past denial.
    const select = () => [LOCKED];
    expect(ownerListState({ permitted: false, loading: true, error: 'X' }, select)).toEqual({
      kind: 'unauthorized',
    });
  });

  test('the selector is NOT consulted while denied (no list is even computed)', () => {
    let called = false;
    const select = () => {
      called = true;
      return [] as PinTargetUser[];
    };
    ownerListState({ permitted: false, loading: false, error: null }, select);
    expect(called).toBe(false);
  });

  test('permitted: loading, then error, then the selected ready list', () => {
    expect(ownerListState({ permitted: true, loading: true, error: null }, () => [])).toEqual({
      kind: 'loading',
    });
    expect(
      ownerListState({ permitted: true, loading: false, error: 'UNEXPECTED' }, () => []),
    ).toEqual({
      kind: 'error',
      code: 'UNEXPECTED',
    });
    expect(
      ownerListState({ permitted: true, loading: false, error: null }, () => [LOCKED]),
    ).toEqual({
      kind: 'ready',
      targets: [LOCKED],
    });
  });
});
