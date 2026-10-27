// A screen lock rides in the ticket's one passcode text as "<kind>:<value>"; older passcodes,
// written before kinds, read back as typed.
import { expect, test } from 'vitest';

import {
  decodeScreenLock,
  encodeScreenLock,
  isPattern,
  patternSteps,
} from '../src/repair/screen-lock.js';

test('each kind round-trips, a colon in a password included', () => {
  for (const lock of [
    { kind: 'pin', value: '004521' },
    { kind: 'password', value: 'pin:1234' },
    { kind: 'pattern', value: '14753' },
  ] as const) {
    expect(decodeScreenLock(encodeScreenLock(lock))).toEqual(lock);
  }
});

test('a passcode from before kinds, or a malformed pattern, reads back as typed', () => {
  expect(decodeScreenLock('1234')).toEqual({ kind: 'unknown', value: '1234' });
  expect(decodeScreenLock('pattern:1123')).toEqual({ kind: 'unknown', value: 'pattern:1123' });
  expect(decodeScreenLock('face:abc')).toEqual({ kind: 'unknown', value: 'face:abc' });
});

test('a pattern is dots 1-9, each once', () => {
  expect(isPattern('159')).toBe(true);
  expect(isPattern('1591')).toBe(false);
  expect(isPattern('1059')).toBe(false);
  expect(isPattern('')).toBe(false);
  expect(patternSteps('14753')).toBe('1-4-7-5-3');
});
