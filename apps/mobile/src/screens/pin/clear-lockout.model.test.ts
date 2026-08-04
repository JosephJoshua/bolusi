import { DomainError } from '@bolusi/core';
import { describe, expect, test } from 'vitest';

import {
  CLEAR_IDLE,
  clearActionReducer,
  clearListState,
  clearLockoutOutcome,
  type ClearAction,
} from './clear-lockout.model.js';
import type { PinTargetUser } from './pin-target.js';

const LOCKED: PinTargetUser = { id: 'u-locked', name: 'Ani', lockedOut: true };
const OPEN: PinTargetUser = { id: 'u-open', name: 'Budi', lockedOut: false };

describe('clearListState — permission is checked first; denial never masquerades as empty (§5)', () => {
  test('no `auth.pin_unlock` → Unauthorized, even when users ARE locked', () => {
    const state = clearListState({
      canUnlock: false,
      loading: false,
      error: null,
      users: [LOCKED],
    });
    expect(state).toEqual({ kind: 'unauthorized' });
  });

  test('no permission still shows Unauthorized (not Empty) when nobody is locked', () => {
    // The FR-1036 trap: an empty list would read as "nobody is locked", leaking that fact to a
    // non-owner and hiding the denial. Permission wins over the empty check.
    const state = clearListState({ canUnlock: false, loading: false, error: null, users: [] });
    expect(state).toEqual({ kind: 'unauthorized' });
  });

  test('loading is surfaced', () => {
    expect(clearListState({ canUnlock: true, loading: true, error: null, users: [] })).toEqual({
      kind: 'loading',
    });
  });

  test('a directory-read error is surfaced with its code', () => {
    expect(
      clearListState({ canUnlock: true, loading: false, error: 'UNEXPECTED', users: [] }),
    ).toEqual({ kind: 'error', code: 'UNEXPECTED' });
  });

  test('ready offers ONLY the locked users — an unlocked user is never a target', () => {
    const state = clearListState({
      canUnlock: true,
      loading: false,
      error: null,
      users: [LOCKED, OPEN],
    });
    expect(state).toEqual({ kind: 'ready', targets: [LOCKED] });
  });

  test('ready with nobody locked is an empty target list (the reassuring case)', () => {
    const state = clearListState({ canUnlock: true, loading: false, error: null, users: [OPEN] });
    expect(state).toEqual({ kind: 'ready', targets: [] });
  });
});

describe('clearActionReducer — an unlock requires an explicit confirm, never a bare tap', () => {
  test('picking a target opens confirmation, it does NOT submit', () => {
    const action = clearActionReducer(CLEAR_IDLE, { kind: 'pick', target: LOCKED });
    expect(action).toEqual({ kind: 'confirming', target: LOCKED });
  });

  test('nothing but a pick advances from idle — a stray settle cannot clear a lockout', () => {
    expect(clearActionReducer(CLEAR_IDLE, { kind: 'confirm' })).toBe(CLEAR_IDLE);
    expect(clearActionReducer(CLEAR_IDLE, { kind: 'settled', result: { ok: true } })).toBe(
      CLEAR_IDLE,
    );
  });

  test('confirm moves to submitting; cancel returns to idle', () => {
    const confirming: ClearAction = { kind: 'confirming', target: LOCKED };
    expect(clearActionReducer(confirming, { kind: 'confirm' })).toEqual({
      kind: 'submitting',
      target: LOCKED,
    });
    expect(clearActionReducer(confirming, { kind: 'cancel' })).toBe(CLEAR_IDLE);
  });

  test('a success settles to done; a failure carries its reason', () => {
    const submitting: ClearAction = { kind: 'submitting', target: LOCKED };
    expect(clearActionReducer(submitting, { kind: 'settled', result: { ok: true } })).toEqual({
      kind: 'done',
      target: LOCKED,
    });
    expect(
      clearActionReducer(submitting, {
        kind: 'settled',
        result: { ok: false, reason: 'notLocked' },
      }),
    ).toEqual({ kind: 'failed', target: LOCKED, reason: 'notLocked' });
  });

  test('a terminal state dismisses back to the list', () => {
    expect(clearActionReducer({ kind: 'done', target: LOCKED }, { kind: 'dismiss' })).toBe(
      CLEAR_IDLE,
    );
    expect(
      clearActionReducer({ kind: 'failed', target: LOCKED, reason: 'error' }, { kind: 'dismiss' }),
    ).toBe(CLEAR_IDLE);
  });
});

describe('clearLockoutOutcome — a not-locked target is truthful, not a false success', () => {
  test('INVALID_TRANSITION → notLocked (the target was unlocked out from under us)', () => {
    expect(clearLockoutOutcome(new DomainError('INVALID_TRANSITION'))).toEqual({
      ok: false,
      reason: 'notLocked',
    });
  });

  test('any other error → error, never swallowed', () => {
    expect(clearLockoutOutcome(new DomainError('PERMISSION_DENIED'))).toEqual({
      ok: false,
      reason: 'error',
    });
    expect(clearLockoutOutcome(new Error('boom'))).toEqual({ ok: false, reason: 'error' });
    expect(clearLockoutOutcome(null)).toEqual({ ok: false, reason: 'error' });
  });
});
