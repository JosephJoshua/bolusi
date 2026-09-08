/**
 * THE COMPOSED-APP TEST for the session-open-failure degradation (task 201 review finding V6/R10).
 *
 * ── WHAT WAS BROKEN, AND WHY NOTHING NOTICED ────────────────────────────────────────────────────
 * Task 201 hoisted session-open AHEAD of the device-info read + the sync/media loops, so a stalled
 * loop could not starve the switcher roster. `startServicesForEnrolled` (Root.tsx) wraps the
 * device-info read + loops in a try/catch — but the `await startSessionIfEnrolled(...)` it hoisted
 * sits ONE line ABOVE where that try opens. So a THROW inside session-open itself (a rejecting
 * `createSession`, a `loadSigningKey` that rejects, a `refresh()` that throws) is caught by NOTHING:
 * it rejects `startServicesForEnrolled`, and the already-enrolled boot path awaits that inside a
 * `void (async () => …)()` IIFE with no `.catch`. Two symptoms, both invisible to every unit test:
 *   1. `setDeviceInfo` (inside the try, AFTER the hoisted call) never runs, so `deviceInfo` stays
 *      null and Root's render gate (`deviceInfo === null → return null`) BLANKS the whole app.
 *   2. the discarded IIFE promise rejects with no handler → an unhandled promise rejection.
 * The enrolled device is fine; the directory is seeded; the ONLY fault is that session-open threw —
 * and instead of degrading to the pre-unlock picker (from which nothing worse than a failed unlock
 * follows) the app shows a blank screen. A blank screen with an unhandled rejection is strictly the
 * worst outcome and names no cause.
 *
 * ── SO THIS FILE MOUNTS `Root`, NOT the unit ────────────────────────────────────────────────────
 * The defect lives in the composition root's try boundary, not in any single function. Every seam up
 * to session-open is REAL and proven working by the sibling live-shell tests (they reach a session
 * through the same `enrolledDevice` + `seedDirectory` + PIN unlock). The ONLY injected fault is a
 * `createSession` that REJECTS — isolating session-open's throw as the sole cause — and the assertion
 * is that the app still renders the enrolled pre-unlock surface (its `deviceInfo` was set despite the
 * throw). RED on current code (blank tree); GREEN once session-open is wrapped in its own try/catch.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The native modules `Root`'s import graph reaches — doubled exactly as the sibling live-shell tests.
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  setItemAsync: vi.fn(async () => undefined),
  getItemAsync: vi.fn(async () => null),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4, DEFAULT: 3, LOW: 2, MIN: 1 },
  setNotificationChannelAsync: vi.fn(async () => undefined),
  getNotificationChannelsAsync: vi.fn(async () => []),
}));
vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  watchPositionAsync: vi.fn(async () => ({ remove: () => undefined })),
}));

import * as SecureStore from 'expo-secure-store';

import {
  bootFixture,
  closeClientDb,
  enrolledDevice,
  mountRoot,
  seedDirectory,
  settle,
  type Fixture,
} from './live-shell-support.js';

let tempDir: string;
let secureStore: Map<string, string>;
let fixture: Fixture | null = null;

beforeEach(async () => {
  await closeClientDb();
  tempDir = mkdtempSync(join(tmpdir(), 'bolusi-live-shell-session-open-'));
  secureStore = new Map<string, string>();
  vi.clearAllMocks();
  vi.mocked(SecureStore.getItemAsync).mockImplementation(
    async (key: string) => secureStore.get(key) ?? null,
  );
  vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key: string, value: string) => {
    secureStore.set(key, value);
  });
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key: string) => {
    secureStore.delete(key);
  });
});

afterEach(async () => {
  await fixture?.close();
  fixture = null;
  await closeClientDb();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('a session-open throw degrades to the pre-unlock surface, not a blank app (task 201, V6/R10)', () => {
  test('the enrolled picker renders even when `createSession` rejects', async () => {
    fixture = await bootFixture();
    // Real enrolled device + a seeded user directory: every seam up to session-open works (the sibling
    // live-shell tests unlock over exactly this). The ONLY fault is the injected rejecting factory.
    await enrolledDevice(fixture);
    await seedDirectory(fixture);

    const screen = await mountRoot(fixture, {
      createSession: () => Promise.reject(new Error('injected session-open failure')),
    });
    await settle();

    // The app is NOT blank: `deviceInfo` was set despite the throw, so Root's render gate passed and
    // App resolved the enrolled + session-null zone → the switcher (which doubles as the lock screen,
    // zone.ts §2). Its roster is still loading (the roster comes from the session's `refresh()`, which
    // never ran), but the SURFACE renders — `switcher-screen` is on the shell, not gated on the roster.
    // On the pre-fix code the throw skips `setDeviceInfo`, Root's gate returns null, and the whole tree
    // is blank — this query is null. (This also proves the device still reads as ENROLLED: an
    // unenrolled/revoked read would resolve the enrollment zone, not the switcher.)
    expect(screen.query('switcher-screen')).not.toBeNull();
    // And no session opened — we are in the degraded-but-usable pre-unlock state, not the home surface.
    expect(screen.query('notes.list.title')).toBeNull();
  });
});
