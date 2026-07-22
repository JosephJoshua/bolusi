// The API-base-URL guard (T-19). The carry-in: `EXPO_PUBLIC_API_URL = process.env[...] ?? ''` yields
// a RELATIVE URL when unset, so enroll/sync would silently POST to the device. The guard must fail
// loud instead. Falsified by construction: the `unset → throws` case below goes green ONLY because
// the guard rejects — restore the `?? ''` fallback and it returns `''` (a relative base) and this RED.
import { expect, test } from 'vitest';

import { pushProjectId, requireApiBaseUrl } from './config.js';

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

// pushProjectId (api/04-push §7; task 135) — the SOLE honesty gate against feeding a blank/faked EAS
// project id into `getExpoPushTokenAsync` (which throws "Project ID not found" on a blank id, T-19).
// SOFT by design (the opposite of requireApiBaseUrl): push is best-effort (api/04-push §1), so an
// unset id must NOT throw — it returns `null` so the caller SKIPS wiring registration rather than
// passing `''` downstream. Falsified by construction: swap `null` for a `?? ''` fallback and the
// unset/blank cases below return `''` (the faked-read shape) and RED.
test('pushProjectId is null when unset — SKIP registration, never a blank id (best-effort)', () => {
  expect(pushProjectId(undefined)).toBeNull();
});

test('pushProjectId is null for a blank / whitespace id — never fed to getExpoPushTokenAsync', () => {
  expect(pushProjectId('')).toBeNull();
  expect(pushProjectId('   ')).toBeNull();
});

test('pushProjectId returns a set id, trimmed', () => {
  expect(pushProjectId('bolusi-eas-project')).toBe('bolusi-eas-project');
  expect(pushProjectId('  bolusi-eas-project  ')).toBe('bolusi-eas-project');
});
