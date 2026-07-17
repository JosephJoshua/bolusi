// The API-base-URL guard (T-19). The carry-in: `EXPO_PUBLIC_API_URL = process.env[...] ?? ''` yields
// a RELATIVE URL when unset, so enroll/sync would silently POST to the device. The guard must fail
// loud instead. Falsified by construction: the `unset → throws` case below goes green ONLY because
// the guard rejects — restore the `?? ''` fallback and it returns `''` (a relative base) and this RED.
import { expect, test } from 'vitest';

import { requireApiBaseUrl } from './config.js';

test('an unset URL fails loud (never a relative-URL fallback)', () => {
  expect(() => requireApiBaseUrl(undefined)).toThrow(/EXPO_PUBLIC_API_URL is not set/);
});

test('a blank / whitespace URL fails loud too', () => {
  expect(() => requireApiBaseUrl('')).toThrow(/EXPO_PUBLIC_API_URL is not set/);
  expect(() => requireApiBaseUrl('   ')).toThrow(/EXPO_PUBLIC_API_URL is not set/);
});

test('a set URL is returned with any trailing slash trimmed', () => {
  expect(requireApiBaseUrl('https://api.bolusi.example')).toBe('https://api.bolusi.example');
  expect(requireApiBaseUrl('https://api.bolusi.example/')).toBe('https://api.bolusi.example');
  expect(requireApiBaseUrl('https://api.bolusi.example///')).toBe('https://api.bolusi.example');
});
