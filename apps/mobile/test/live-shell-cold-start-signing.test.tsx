// Cold-start signing-key reload, END TO END on the REAL shell (task 201).
//
// The unlock lane (live-shell-unlock) proves a PIN opens a session — but its fixture signs with a
// FAKE in-memory keypair (`live-shell-support` `runtimeFor`: `getSigningKey: () => DEVICE_KEYPAIR…`),
// so it can never see the cold-start bug this file exists for. On an already-enrolled device that was
// KILLED and REOPENED, no enrollment runs, so core's `runEnrollment` mid-flow seed reload — which
// covers a resume DURING enrollment (enrollment.ts `EnrollmentPlatform.keystore` doc) — never fires. A
// fresh `SecureStoreKeyStore` boots with an EMPTY in-memory cache; nothing reloads the persisted seed;
// and the FIRST signed op, the session op at PIN unlock, throws "device signing key not loaded".
//
// This mounts the REAL `Root` for an enrolled device over the PRODUCTION `createAppEnrollment` bound to
// a REAL, COLD `SecureStoreKeyStore` (empty cache, seed present in the mocked SecureStore exactly as
// the original enroll left it on disk). It is the render-boundary reproduction the fake-key host tests
// structurally cannot be: `KeyStorePort.loadSigningKey` "MUST be awaited once at startup before the
// command runtime signs its first op" (api/02-auth §3) — the contract the cold-start path violated.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createUuidV7Generator, type EnrollTransportPort } from '@bolusi/core';
import { mulberry32, noblePort, randomBytes as prngBytes } from '@bolusi/test-support';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The Expo native modules the Root chain touches — doubled so their `__DEV__`-dependent real code never
// loads (the same set every live-shell test mocks). Unlike the other lanes, this one binds a REAL
// `SecureStoreKeyStore`, so the SecureStore double below is backed by a `Map` that actually stores.
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

import { createAppEnrollment, type EnrollmentPlatform } from '../src/bootstrap/enrollment.js';
import type { LoginTransportPort } from '../src/bootstrap/enroll-transport.js';
import type { RootProps } from '../src/bootstrap/Root.js';
import { SecureStoreKeyStore } from '../src/ports/keystore.js';

import { __resetHardwareBack } from './doubles/react-native.js';
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
  type Fixture,
} from './live-shell-support.js';

const FIXED_NOW = 1_726_000_000_000;

let tempDir: string;
let secureStore: Map<string, string>;
let fixture: Fixture | null = null;

beforeEach(async () => {
  await closeClientDb();
  __resetHardwareBack();
  tempDir = mkdtempSync(join(tmpdir(), 'bolusi-live-cold-'));
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
  __resetHardwareBack();
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * A `createEnrollment` factory that binds the PRODUCTION `createAppEnrollment` to a COLD keystore — a
 * fresh `SecureStoreKeyStore` with an EMPTY in-memory cache. Its runtime is the one `Root` composes the
 * session over, and its `signingKey` IS that keystore, so the session op at unlock signs THROUGH the
 * cold cache — reproducing the reopened-app path. The transports reject: an enrolled device never calls
 * them. A distinct id-source seed (23) keeps the session op id off the fixture genesis's stream (seed
 * 119) so the two never collide on the `operations` primary key once signing succeeds.
 */
function coldStartEnrollment(
  coldKeystore: SecureStoreKeyStore,
): NonNullable<RootProps['createEnrollment']> {
  const rejectingLogin: LoginTransportPort = {
    login: () => Promise.reject(new Error('login not used by the cold-start signing test')),
  };
  const rejectingEnroll: EnrollTransportPort = {
    enroll: () => Promise.reject(new Error('enroll not used by the cold-start signing test')),
  };
  const idPrng = mulberry32(23);
  const platform: EnrollmentPlatform = {
    loginTransport: rejectingLogin,
    enrollTransport: rejectingEnroll,
    keystore: coldKeystore,
    crypto: noblePort,
    clock: { now: () => FIXED_NOW },
    idSource: createUuidV7Generator({
      now: () => FIXED_NOW,
      randomBytes: (n) => prngBytes(idPrng, n),
    }),
    location: { getBestFix: () => null },
    platform: 'android',
    appVersion: '0.0.0-test',
  };
  return (app, onEnrolled) => createAppEnrollment(app, platform, onEnrolled);
}

describe('An enrolled device that was killed and reopened can sign the session op (task 201)', () => {
  test('cold start reloads the persisted seed, so PIN unlock opens a session', async () => {
    fixture = await bootFixture();
    await enrolledDevice(fixture);
    await seedDirectory(fixture);

    // The original enroll left the 32-byte seed in SecureStore. A SEPARATE keystore instance persists it
    // (populating the mocked SecureStore `Map` + its own cache), then the COLD keystore `Root` mounts
    // over is a FRESH instance: the seed is on "disk" but its in-memory cache is empty — exactly a
    // reopened app. Two instances model process death; one instance would carry the cache across.
    const seeder = new SecureStoreKeyStore();
    await seeder.persistDevicePrivateKey(new Uint8Array(32).fill(7));
    const cold = new SecureStoreKeyStore();

    const screen = await mountRoot(fixture, { createEnrollment: coldStartEnrollment(cold) });

    fireOn(screen, `switcher-user-${fixture.userId}`);
    await settle();
    // Without the cold-start reload, composing the session runtime over `cold` leaves its cache empty,
    // so the session op's synchronous `getSigningKey()` throws "device signing key not loaded" and the
    // pad never clears → `opened` is false. With it, `Root` awaits `loadSigningKey()` before composing
    // the session, the cache is populated from SecureStore, the op signs, and the session opens.
    const opened = await submitPin(screen, TEST_PIN);
    expect(opened).toBe(true);
  });
});
