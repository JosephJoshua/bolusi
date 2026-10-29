import { describe, expect, test } from 'vitest';

import {
  advanceNewPin,
  NEW_PIN_START,
  newPinFeedbackKey,
  newPinPadKey,
  newPinPadState,
  newPinPromptKey,
  type NewPinEntry,
} from './new-pin.js';

describe('advanceNewPin — a new PIN is submittable ONLY after an equal repeat (api/02-auth §6.6)', () => {
  test('a PIN anyone would guess is refused before the repeat, with its own message', () => {
    for (const pin of ['111111', '123456', '987654', '121212', '123123', '147258']) {
      const entry = advanceNewPin(NEW_PIN_START, pin);
      expect(entry).toEqual({ kind: 'first', problem: 'weak', refusals: 1 });
      expect(newPinFeedbackKey(entry)).toBe('auth.pin.setup.weak');
      expect(newPinPadState(entry)).toBe('error');
    }
  });

  test('each refusal in a row gives the pad a new key, so it clears every time', () => {
    const once = advanceNewPin(NEW_PIN_START, '111111');
    const twice = advanceNewPin(once, '123456');
    expect(new Set([NEW_PIN_START, once, twice].map(newPinPadKey)).size).toBe(3);
    const mismatch = advanceNewPin({ kind: 'repeat', first: '135790' }, '024680');
    expect(newPinPadKey(advanceNewPin(mismatch, '111111'))).not.toBe(newPinPadKey(mismatch));
  });

  test('the first entry is captured and the repeat is requested', () => {
    const entry = advanceNewPin(NEW_PIN_START, '135790');
    expect(entry).toEqual({ kind: 'repeat', first: '135790' });
  });

  test('an EQUAL repeat matches and carries the confirmed PIN', () => {
    const entry = advanceNewPin({ kind: 'repeat', first: '135790' }, '135790');
    expect(entry).toEqual({ kind: 'matched', pin: '135790' });
  });

  test('a DIFFERENT repeat NEVER matches — it falls back to a fresh first entry with the mismatch flag', () => {
    // The load-bearing security case: a mistyped confirmation must not become a submittable PIN.
    // `matched` has exactly one producer (the equal-repeat arm); this proves the unequal arm avoids it.
    const entry = advanceNewPin({ kind: 'repeat', first: '135790' }, '024680');
    expect(entry.kind).not.toBe('matched');
    expect(entry).toEqual({ kind: 'first', problem: 'mismatch' });
  });

  test('a one-digit difference in the repeat still does not match', () => {
    const entry = advanceNewPin({ kind: 'repeat', first: '111111' }, '111112');
    expect(entry.kind).toBe('first');
  });

  test('`matched` is terminal — a late completion does not re-open a settled entry', () => {
    const matched: NewPinEntry = { kind: 'matched', pin: '246802' };
    expect(advanceNewPin(matched, '999999')).toBe(matched);
  });
});

describe('the question and feedback for a new PIN — key mapping, not copy', () => {
  test('the first entry asks for a new PIN with a tip under the dots', () => {
    const entry = { kind: 'first', problem: null } as const;
    expect(newPinPromptKey(entry)).toBe('auth.pin.setup.title');
    expect(newPinFeedbackKey(entry)).toBe('auth.pin.setup.hint');
    expect(newPinPadState(entry)).toBe('entry');
  });

  test('after a mismatch it asks again and says why, in the error state', () => {
    const entry = { kind: 'first', problem: 'mismatch' } as const;
    expect(newPinPromptKey(entry)).toBe('auth.pin.setup.title');
    expect(newPinFeedbackKey(entry)).toBe('auth.pin.setup.mismatch');
    expect(newPinPadState(entry)).toBe('error');
  });

  test('the repeat asks for the repeat with nothing under the dots', () => {
    const entry = { kind: 'repeat', first: '135790' } as const;
    expect(newPinPromptKey(entry)).toBe('auth.pin.setup.repeat');
    expect(newPinFeedbackKey(entry)).toBeNull();
  });
});
