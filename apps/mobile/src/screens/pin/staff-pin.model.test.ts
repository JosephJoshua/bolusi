import { describe, expect, test } from 'vitest';

import type { PinTargetUser } from './pin-target.js';
import { staffListState, staffPinActions, staffPinBodyKey } from './staff-pin.model.js';

const OWNER = { id: 'u-owner', name: 'Andi', lockedOut: false };
const BUDI = { id: 'u-budi', name: 'Budi', lockedOut: false };
const YOSUA = { id: 'u-yosua', name: 'Yosua', lockedOut: true };
const AGUS = { id: 'u-agus', name: 'Agus', lockedOut: false };

const base = {
  loading: false,
  error: null,
  users: [OWNER, BUDI, YOSUA, AGUS],
  actorUserId: 'u-owner',
};

describe('staff PIN list', () => {
  test('leaves out the owner, puts locked PINs first, then sorts by name', () => {
    const state = staffListState({ ...base, canUnlock: true, canReset: true });
    expect(state.kind === 'ready' && state.targets.map((u) => u.id)).toEqual([
      'u-yosua',
      'u-agus',
      'u-budi',
    ]);
  });

  test('is refused to someone who may neither unlock nor reset', () => {
    expect(staffListState({ ...base, canUnlock: false, canReset: false }).kind).toBe(
      'unauthorized',
    );
  });

  test('is shown to someone who may do only one of the two', () => {
    expect(staffListState({ ...base, canUnlock: true, canReset: false }).kind).toBe('ready');
    expect(staffListState({ ...base, canUnlock: false, canReset: true }).kind).toBe('ready');
  });
});

describe('what the person page offers', () => {
  test('a locked PIN leads with unlock, then reset', () => {
    expect(staffPinActions(YOSUA, { canUnlock: true, canReset: true })).toEqual([
      'unlock',
      'reset',
    ]);
  });

  test('an unlocked PIN can only be reset', () => {
    expect(staffPinActions(BUDI, { canUnlock: true, canReset: true })).toEqual(['reset']);
  });

  test('each action needs its own permission', () => {
    expect(staffPinActions(YOSUA, { canUnlock: false, canReset: true })).toEqual(['reset']);
    expect(staffPinActions(YOSUA, { canUnlock: true, canReset: false })).toEqual(['unlock']);
    expect(staffPinActions(BUDI, { canUnlock: true, canReset: false })).toEqual([]);
  });
});

describe('an owner who may only unlock', () => {
  const locked: PinTargetUser = { id: 'l', name: 'Ani', lockedOut: true };
  const active: PinTargetUser = { id: 'a', name: 'Budi', lockedOut: false };

  test('sees only locked colleagues: nobody else has anything to offer them', () => {
    const list = staffListState({
      canUnlock: true,
      canReset: false,
      loading: false,
      error: null,
      users: [active, locked],
      actorUserId: 'owner',
    });
    expect(list.kind === 'ready' ? list.targets.map((u) => u.id) : null).toEqual(['l']);
  });

  test('is never told to make a new PIN, and a reset-only owner is never told to unlock', () => {
    expect(staffPinBodyKey(locked, ['unlock'])).toBeNull();
    expect(staffPinBodyKey(locked, ['reset'])).toBeNull();
    expect(staffPinBodyKey(locked, ['unlock', 'reset'])).toBe('auth.pin.staff.lockedBody');
    expect(staffPinBodyKey(active, ['reset'])).toBeNull();
    expect(staffPinBodyKey({ ...active, needsFirstPin: true }, ['reset'])).toBe(
      null,
    );
  });
});
