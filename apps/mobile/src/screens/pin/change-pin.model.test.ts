import { DomainError } from '@bolusi/core';
import { describe, expect, test } from 'vitest';

import {
  CHANGE_PIN_START,
  changeMessageKey,
  changePadState,
  changePinFailure,
  changePinReducer,
  type ChangePinPhase,
} from './change-pin.model.js';

/** Drive the reducer through a list of events from a start phase. */
function run(
  start: ChangePinPhase,
  events: Parameters<typeof changePinReducer>[1][],
): ChangePinPhase {
  return events.reduce(changePinReducer, start);
}

describe('changePinReducer — collect current → new → repeat → submit', () => {
  test('the happy path reaches `submitting` carrying BOTH the current and the confirmed new PIN', () => {
    const phase = run(CHANGE_PIN_START, [
      { kind: 'enteredCurrent', pin: '111111' },
      { kind: 'enteredNew', pin: '222222' },
      { kind: 'enteredNew', pin: '222222' },
    ]);
    expect(phase).toEqual({ kind: 'submitting', currentPin: '111111', newPin: '222222' });
  });

  test('a mismatched repeat NEVER submits — it stays in `new`, never reaching `submitting`', () => {
    const phase = run(CHANGE_PIN_START, [
      { kind: 'enteredCurrent', pin: '111111' },
      { kind: 'enteredNew', pin: '222222' },
      { kind: 'enteredNew', pin: '333333' },
    ]);
    expect(phase.kind).toBe('new');
    // The confirmed value is discarded; the sub-flow is back to a fresh first entry, flagged mismatch.
    expect(phase).toMatchObject({ kind: 'new', entry: { kind: 'first', afterMismatch: true } });
  });

  test('a successful settle reaches `done`', () => {
    const phase = changePinReducer(
      { kind: 'submitting', currentPin: '111111', newPin: '222222' },
      { kind: 'settled', result: { ok: true } },
    );
    expect(phase).toEqual({ kind: 'done' });
  });

  test('a FAILED settle never reaches `done` — it returns to the current step carrying the reason', () => {
    for (const reason of ['wrongCurrent', 'locked', 'rateLimited', 'error'] as const) {
      const phase = changePinReducer(
        { kind: 'submitting', currentPin: '111111', newPin: '222222' },
        { kind: 'settled', result: { ok: false, reason } },
      );
      expect(phase).toEqual({ kind: 'current', feedback: reason });
      // And it drops the in-memory PINs by leaving `submitting`.
      expect(phase).not.toHaveProperty('currentPin');
      expect(phase).not.toHaveProperty('newPin');
    }
  });

  test('an out-of-phase event is ignored rather than corrupting the phase', () => {
    // A late new-PIN completion arriving while we are still on the current step changes nothing.
    expect(changePinReducer(CHANGE_PIN_START, { kind: 'enteredNew', pin: '222222' })).toBe(
      CHANGE_PIN_START,
    );
    // A stray current-entry after we have started submitting does not restart entry.
    const submitting: ChangePinPhase = { kind: 'submitting', currentPin: '1', newPin: '2' };
    expect(changePinReducer(submitting, { kind: 'enteredCurrent', pin: '9' })).toBe(submitting);
  });
});

describe('changePinFailure — the flow’s DomainError maps to a pad feedback, never to success', () => {
  test('a wrong current PIN maps to `wrongCurrent`', () => {
    const error = new DomainError('NOT_AUTHENTICATED', { reason: 'current_pin_incorrect' });
    expect(changePinFailure(error)).toEqual({ ok: false, reason: 'wrongCurrent' });
  });

  test('a hard lock maps to `locked`', () => {
    expect(changePinFailure(new DomainError('PIN_LOCKED'))).toEqual({
      ok: false,
      reason: 'locked',
    });
  });

  test('an escalation window maps to `rateLimited`', () => {
    expect(changePinFailure(new DomainError('PIN_RATE_LIMITED'))).toEqual({
      ok: false,
      reason: 'rateLimited',
    });
  });

  test('an unknown error maps to `error` — never swallowed into a false ok', () => {
    expect(changePinFailure(new Error('boom'))).toEqual({ ok: false, reason: 'error' });
    expect(changePinFailure(null)).toEqual({ ok: false, reason: 'error' });
    expect(changePinFailure({ code: 42 })).toEqual({ ok: false, reason: 'error' });
  });
});

describe('changePadState — the hard lock is the only state that disables the keys', () => {
  test('a hard lock disables the pad', () => {
    expect(changePadState({ kind: 'current', feedback: 'locked' })).toBe('locked');
  });

  test('a wrong current / rate-limit leaves the pad live (retryable), shown as error', () => {
    expect(changePadState({ kind: 'current', feedback: 'wrongCurrent' })).toBe('error');
    expect(changePadState({ kind: 'current', feedback: 'rateLimited' })).toBe('error');
  });

  test('a clean current step and normal new entries are live', () => {
    expect(changePadState(CHANGE_PIN_START)).toBe('entry');
    expect(
      changePadState({
        kind: 'new',
        currentPin: '1',
        entry: { kind: 'first', afterMismatch: false },
      }),
    ).toBe('entry');
  });

  test('a mismatch shows error (clearing the pad)', () => {
    expect(
      changePadState({
        kind: 'new',
        currentPin: '1',
        entry: { kind: 'first', afterMismatch: true },
      }),
    ).toBe('error');
  });
});

describe('changeMessageKey — key mapping per phase (never asserts copy)', () => {
  test('each current-step feedback resolves its key', () => {
    expect(changeMessageKey(CHANGE_PIN_START)).toBe('auth.pin.change.enterCurrent');
    expect(changeMessageKey({ kind: 'current', feedback: 'wrongCurrent' })).toBe(
      'auth.pin.change.wrongCurrent',
    );
    expect(changeMessageKey({ kind: 'current', feedback: 'locked' })).toBe('auth.pin.lockedOut');
    expect(changeMessageKey({ kind: 'current', feedback: 'rateLimited' })).toBe(
      'core.errors.PIN_RATE_LIMITED',
    );
    expect(changeMessageKey({ kind: 'current', feedback: 'error' })).toBe('core.errors.UNEXPECTED');
  });

  test('the new-PIN step delegates to the shared sub-flow’s keys', () => {
    expect(
      changeMessageKey({
        kind: 'new',
        currentPin: '1',
        entry: { kind: 'first', afterMismatch: false },
      }),
    ).toBe('auth.pin.setup.title');
    expect(
      changeMessageKey({ kind: 'new', currentPin: '1', entry: { kind: 'repeat', first: '2' } }),
    ).toBe('auth.pin.setup.repeat');
  });

  test('submitting and done show no pad message', () => {
    expect(changeMessageKey({ kind: 'submitting', currentPin: '1', newPin: '2' })).toBeNull();
    expect(changeMessageKey({ kind: 'done' })).toBeNull();
  });
});
