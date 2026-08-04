import { describe, expect, test } from 'vitest';

import { advanceNewPin, NEW_PIN_START, newPinMessageKey, type NewPinEntry } from './new-pin.js';

describe('advanceNewPin — a new PIN is submittable ONLY after an equal repeat (api/02-auth §6.6)', () => {
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
    expect(entry).toEqual({ kind: 'first', afterMismatch: true });
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

describe('newPinMessageKey — key mapping, not copy', () => {
  test('the first entry invites a new PIN', () => {
    expect(newPinMessageKey({ kind: 'first', afterMismatch: false })).toBe('auth.pin.setup.title');
  });

  test('after a mismatch the first entry says the PINs did not match', () => {
    expect(newPinMessageKey({ kind: 'first', afterMismatch: true })).toBe(
      'auth.pin.setup.mismatch',
    );
  });

  test('the repeat asks for the repeat', () => {
    expect(newPinMessageKey({ kind: 'repeat', first: '135790' })).toBe('auth.pin.setup.repeat');
  });

  test('a matched entry renders no message — the caller has moved on to submit', () => {
    expect(newPinMessageKey({ kind: 'matched', pin: '135790' })).toBeNull();
  });
});
