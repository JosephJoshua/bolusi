/**
 * THE COMPOSED-APP TEST for task 135 — does the running app REGISTER a push token and ROUTE a tap?
 *
 * ── WHAT WAS BROKEN, AND WHY NOTHING NOTICED ────────────────────────────────────────────────────
 * `registerPushTokenOnAppStart` / `registerPushTokenOnEnrollment` (push/registration.ts) and
 * `resolvePushRoute` (push/routes.ts) shipped with sound unit tests and ZERO production importers.
 * Neither `index.ts` nor `Root.tsx` called them, so on a real device the app created notification
 * CHANNELS at every boot (createNotificationChannels) and then never registered a token to receive a
 * notification, and a tap routed nowhere. Reproduced before the fix: breaking
 * `registerPushTokenOnAppStart` and `resolvePushRoute` reddened ONLY `src/push/registration.test.ts`
 * (2) and `src/push/routes.test.ts` (2); every bootstrap/Root/live-shell test stayed green — the exact
 * "sound tests, zero callers" class (CLAUDE.md §2.11).
 *
 * ── SO THIS FILE MOUNTS `Root`, NOT the unit ────────────────────────────────────────────────────
 * A test that called `registerPushTokenOnAppStart` directly (registration.test.ts) was GREEN BEFORE
 * the fix and proves nothing about the defect, which was the MISSING PRODUCER. So this drives the
 * composition root: boot the REAL data layer, reach a session through the REAL PIN unlock, and assert
 * the app calls the registration seam with THIS device's id — and that a `conflict` tap navigates to
 * the reachable sync-status route while an unknown tap navigates nowhere. Break `Root`'s wiring and
 * the assertions below red; the unit tests would not.
 *
 * ── EVERYTHING BELOW THE SEAM IS REAL (T-7) ─────────────────────────────────────────────────────
 * Real `bootstrap()` over better-sqlite3, real `applyBundle`, real argon2id verifier, real `verifyPin`,
 * real `SessionManager`, the REAL `registerPushTokenOnAppStart` (its diff-gate + error swallow) and the
 * REAL `resolvePushRoute` → `resolvePushShellRoute`. The only fakes are the two native seams a Node run
 * cannot have: the Expo token acquisition + the `POST /v1/push/tokens` transport (the fake records the
 * call), and the notification listener (the fake emits a tap). That is the boundary index.ts binds.
 *
 * ── WHAT THIS LANE CANNOT ANSWER — read before trusting a green ─────────────────────────────────
 * This proves the WIRING: given a session, the app registers; given a tap payload, it routes. It does
 * NOT prove Expo's push service delivers to a handset, that FCM credentials are set (task 21), or that
 * `getExpoPushTokenAsync` succeeds on a real device — the standing D12/D13 on-device ceiling.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The native modules `Root`'s import graph reaches — doubled exactly as the sibling live-shell tests
// do. `getExpoPushTokenAsync` is added because `registration.ts` calls it; the notification LISTENER
// functions are NOT here, because `Root` takes the listener as an injected port (this file's fake) and
// its import graph never touches `expo-notifications`' listener API — index.ts does, and index.ts is
// not in this graph.
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  setItemAsync: vi.fn(async () => undefined),
  getItemAsync: vi.fn(async () => null),
  deleteItemAsync: vi.fn(async () => undefined),
}));

vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));

const EXPO_TOKEN = 'ExponentPushToken[live-shell-135]';
vi.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4, DEFAULT: 3, LOW: 2, MIN: 1 },
  setNotificationChannelAsync: vi.fn(async () => undefined),
  getNotificationChannelsAsync: vi.fn(async () => []),
  getExpoPushTokenAsync: vi.fn(async () => ({ data: EXPO_TOKEN, type: 'expo' as const })),
}));

vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  getForegroundPermissionsAsync: vi.fn(async () => ({ status: 'denied' })),
  watchPositionAsync: vi.fn(async () => ({ remove: () => undefined })),
}));

import * as SecureStore from 'expo-secure-store';

import type { RootProps } from '../src/bootstrap/Root.js';
import type { PushResponse } from '../src/push/router.js';
import {
  bootFixture,
  closeClientDb,
  enrolledDevice,
  fireOn,
  mountRoot,
  seedDirectory,
  settle,
  submitPin,
  TEST_PIN,
  waitUntil,
  type Fixture,
} from './live-shell-support.js';
import type { RenderResult } from '../../../packages/ui/test/render.js';

/** A `postToken` call the fake registration seam saw — the wire the server (task 134) would receive. */
interface RecordedPost {
  readonly deviceId: string | null;
  readonly actingUserId: string | null;
  readonly token: string;
}

/**
 * A fake `createPushRegistration` over the REAL `registration.ts` logic: it supplies the injected ports
 * (in-memory last-registered, a recording `postToken`) so `registerPushTokenOnAppStart`'s diff-gate and
 * its `getExpoPushTokenAsync` acquisition run for real, and records what would have been POSTed.
 */
function fakePushRegistration(): {
  readonly factory: NonNullable<RootProps['createPushRegistration']>;
  readonly posts: readonly RecordedPost[];
} {
  const posts: RecordedPost[] = [];
  let lastRegistered: string | null = null;
  return {
    posts,
    factory: (app, actingUserId) => ({
      projectId: 'test-project-135',
      readLastRegistered: () => Promise.resolve(lastRegistered),
      writeLastRegistered: (token) => {
        lastRegistered = token;
        return Promise.resolve();
      },
      postToken: (token) => {
        posts.push({ deviceId: app.deviceId, actingUserId, token });
        return Promise.resolve();
      },
      onError: () => undefined,
    }),
  };
}

/** A fake notification-tap seam whose `emit(data)` drives one warm tap through `Root`'s handler. */
function fakePushRouter(): {
  readonly port: NonNullable<RootProps['pushRouter']>;
  emit(data: unknown): void;
} {
  let handler: ((response: PushResponse) => void) | null = null;
  return {
    port: {
      subscribeToResponses(next) {
        handler = next;
        return () => {
          handler = null;
        };
      },
      getInitialResponse: () => Promise.resolve(null),
    },
    emit(data: unknown) {
      handler?.({ data });
    },
  };
}

const CONFLICT_ID = '018f4e2a-1111-7abc-8def-000000000abc';

let tempDir: string;
let secureStore: Map<string, string>;
let fixture: Fixture | null = null;

beforeEach(async () => {
  await closeClientDb();
  tempDir = mkdtempSync(join(tmpdir(), 'bolusi-live-shell-push-'));
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

/** Boot an enrolled device, mount the LIVE `Root` with the push seams, and sign in through the pad. */
async function liveShellWithSession(
  target: Fixture,
  push: {
    readonly createPushRegistration?: RootProps['createPushRegistration'];
    readonly pushRouter?: RootProps['pushRouter'];
  },
): Promise<RenderResult> {
  await enrolledDevice(target);
  await seedDirectory(target);
  const screen = await mountRoot(target, push);
  fireOn(screen, `switcher-user-${target.userId}`);
  await settle();
  const opened = await submitPin(screen, TEST_PIN);
  expect(opened).toBe(true);
  return screen;
}

describe('the LIVE shell registers a push token and routes a tap (task 135; api/04-push §2/§4)', () => {
  test('THE REPRODUCTION, STANDING: a session ⇒ the app registers THIS device`s push token', async () => {
    fixture = await bootFixture();
    const push = fakePushRegistration();
    const screen = await liveShellWithSession(fixture, { createPushRegistration: push.factory });

    // Denominator (T-14): the shell actually opened on the notes surface. Without this the registration
    // assertion could pass against a shell that never reached a session.
    expect(screen.query('notes.list.title')).not.toBeNull();

    // THE ASSERTION THIS TASK EXISTS FOR. `registerPushTokenOnAppStart` ran through the REAL diff-gate
    // (last-registered was null ⇒ it POSTs) and reached the transport seam carrying THIS device's id
    // and the signed-in user as the acting user (X-Acting-User, api/04-push §2/§4). Before this task
    // nothing in shipping source called it, so `posts` would stay empty forever.
    await waitUntil(() => push.posts.length > 0);
    expect(push.posts).toHaveLength(1);
    expect(push.posts[0]?.token).toBe(EXPO_TOKEN);
    expect(push.posts[0]?.deviceId).toBe(fixture.deviceId);
    expect(push.posts[0]?.actingUserId).toBe(fixture.userId);
  });

  test('a `conflict` tap navigates to the sync-status route (api/04-push §4)', async () => {
    fixture = await bootFixture();
    const router = fakePushRouter();
    const screen = await liveShellWithSession(fixture, { pushRouter: router.port });

    // On the home surface — the denominator. The sync-status screen is NOT showing yet.
    expect(screen.query('notes.list.title')).not.toBeNull();
    expect(screen.query('sync-status-screen')).toBeNull();

    // Tap a conflict notification. `resolvePushRoute` validates the wire shape, `resolvePushShellRoute`
    // maps it to the reachable `syncStatus` route, and `App` applies it — the sync-status screen shows.
    await act(async () => {
      router.emit({
        category: 'conflict',
        route: 'conflicts',
        params: { conflictId: CONFLICT_ID },
      });
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });

    expect(screen.query('sync-status-screen')).not.toBeNull();
    expect(screen.query('notes.list.title')).toBeNull();
  });

  test('POSITIVE CONTROL: an unknown payload navigates NOWHERE — so "always navigates" cannot pass', async () => {
    fixture = await bootFixture();
    const router = fakePushRouter();
    const screen = await liveShellWithSession(fixture, { pushRouter: router.port });

    expect(screen.query('notes.list.title')).not.toBeNull();
    expect(screen.query('sync-status-screen')).toBeNull();

    // An unknown route key resolves to null (routes.ts) ⇒ the shell must not move. If routing were
    // hardcoded to "always navigate", this would land on sync-status and this test would red.
    await act(async () => {
      router.emit({ category: 'promo', route: 'payments', params: { id: 'x' } });
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });

    expect(screen.query('notes.list.title')).not.toBeNull();
    expect(screen.query('sync-status-screen')).toBeNull();
  });
});
