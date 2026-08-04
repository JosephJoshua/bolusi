import { DomainError } from '@bolusi/core';
import { describe, expect, test } from 'vitest';

import type { PinTargetUser } from './pin-target.js';
import {
  RESET_LIST,
  resetListState,
  resetOutcome,
  resetPinReducer,
  type ResetPhase,
} from './reset-pin.model.js';

const OWNER: PinTargetUser = { id: 'u-owner', name: 'Ocep', lockedOut: false };
const STAFF: PinTargetUser = { id: 'u-staff', name: 'Ani', lockedOut: false };

describe('resetListState — permission first; the acting owner is not a reset target', () => {
  test('no `auth.user_reset_pin` → Unauthorized, even with users present', () => {
    const state = resetListState({
      canReset: false,
      loading: false,
      error: null,
      users: [OWNER, STAFF],
      actorUserId: OWNER.id,
    });
    expect(state).toEqual({ kind: 'unauthorized' });
  });

  test('ready excludes the acting owner — reset is for someone else (self uses change-PIN)', () => {
    const state = resetListState({
      canReset: true,
      loading: false,
      error: null,
      users: [OWNER, STAFF],
      actorUserId: OWNER.id,
    });
    expect(state).toEqual({ kind: 'ready', targets: [STAFF] });
  });

  test('a device with only the owner has no other users to reset (meaningful Empty)', () => {
    const state = resetListState({
      canReset: true,
      loading: false,
      error: null,
      users: [OWNER],
      actorUserId: OWNER.id,
    });
    expect(state).toEqual({ kind: 'ready', targets: [] });
  });

  test('loading and directory errors are surfaced', () => {
    expect(
      resetListState({
        canReset: true,
        loading: true,
        error: null,
        users: [],
        actorUserId: OWNER.id,
      }),
    ).toEqual({ kind: 'loading' });
    expect(
      resetListState({
        canReset: true,
        loading: false,
        error: 'UNEXPECTED',
        users: [],
        actorUserId: OWNER.id,
      }),
    ).toEqual({ kind: 'error', code: 'UNEXPECTED' });
  });
});

describe('resetPinReducer — choose → hand over → target enters new PIN → submit', () => {
  test('the happy path reaches submitting with the CONFIRMED new PIN', () => {
    const phase = [
      { kind: 'pick', target: STAFF } as const,
      { kind: 'proceed' } as const,
      { kind: 'enteredPin', pin: '246802' } as const,
      { kind: 'enteredPin', pin: '246802' } as const,
    ].reduce<ResetPhase>(resetPinReducer, RESET_LIST);
    expect(phase).toEqual({ kind: 'submitting', target: STAFF, newPin: '246802' });
  });

  test('a mismatched repeat NEVER submits — it stays in entering', () => {
    const phase = [
      { kind: 'pick', target: STAFF } as const,
      { kind: 'proceed' } as const,
      { kind: 'enteredPin', pin: '246802' } as const,
      { kind: 'enteredPin', pin: '999999' } as const,
    ].reduce<ResetPhase>(resetPinReducer, RESET_LIST);
    expect(phase.kind).toBe('entering');
    expect(phase).toMatchObject({
      kind: 'entering',
      entry: { kind: 'first', afterMismatch: true },
    });
  });

  test('picking a target opens the hand-over step, never the pad directly', () => {
    expect(resetPinReducer(RESET_LIST, { kind: 'pick', target: STAFF })).toEqual({
      kind: 'handOver',
      target: STAFF,
    });
  });

  test('cancel from hand-over or entering returns to the list', () => {
    expect(resetPinReducer({ kind: 'handOver', target: STAFF }, { kind: 'cancel' })).toBe(
      RESET_LIST,
    );
    expect(
      resetPinReducer(
        { kind: 'entering', target: STAFF, entry: { kind: 'first', afterMismatch: false } },
        { kind: 'cancel' },
      ),
    ).toBe(RESET_LIST);
  });

  test('a success settles to done; a failure carries its reason; dismiss returns to the list', () => {
    const submitting: ResetPhase = { kind: 'submitting', target: STAFF, newPin: '246802' };
    expect(resetPinReducer(submitting, { kind: 'settled', result: { ok: true } })).toEqual({
      kind: 'done',
      target: STAFF,
    });
    const failed = resetPinReducer(submitting, {
      kind: 'settled',
      result: { ok: false, reason: 'denied' },
    });
    expect(failed).toEqual({ kind: 'failed', target: STAFF, reason: 'denied' });
    expect(resetPinReducer(failed, { kind: 'dismiss' })).toBe(RESET_LIST);
  });

  test('a stray settle before submitting cannot reset anyone', () => {
    expect(resetPinReducer(RESET_LIST, { kind: 'settled', result: { ok: true } })).toBe(RESET_LIST);
    expect(
      resetPinReducer(
        { kind: 'handOver', target: STAFF },
        { kind: 'settled', result: { ok: true } },
      ),
    ).toEqual({ kind: 'handOver', target: STAFF });
  });
});

describe('resetOutcome — the privileged-target denial is truthful, never a false success', () => {
  test('PERMISSION_DENIED + restriction_violated → denied (§6.6 main-owner rule)', () => {
    const error = new DomainError('PERMISSION_DENIED', { reason: 'restriction_violated' });
    expect(resetOutcome(error)).toEqual({ ok: false, reason: 'denied' });
  });

  test('a bare PERMISSION_DENIED (no restriction reason) is an unexpected error, not a denial', () => {
    expect(resetOutcome(new DomainError('PERMISSION_DENIED'))).toEqual({
      ok: false,
      reason: 'error',
    });
  });

  test('any other error → error', () => {
    expect(resetOutcome(new DomainError('INVALID_TRANSITION'))).toEqual({
      ok: false,
      reason: 'error',
    });
    expect(resetOutcome(new Error('boom'))).toEqual({ ok: false, reason: 'error' });
    expect(resetOutcome(null)).toEqual({ ok: false, reason: 'error' });
  });
});
