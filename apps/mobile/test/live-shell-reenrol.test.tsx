/**
 * Re-enrolling a phone the server no longer recognises, through the LIVE `Root`.
 *
 * The loop stops syncing once the server keeps refusing the phone's token (core sync/loop.ts). The
 * phone keeps working; the sync screen says it needs registering again and offers that as its one
 * action. The owner signs in, sees whose unsent changes the phone holds, and binds it again to the
 * same store. Core then carries those changes over to the new registration (core auth/carry-over.ts).
 *
 * This drives the whole path through the real composition, because the parts that can break are the
 * wires between them: the sync screen's button reaching the gate, the wizard reading what the phone
 * holds, and Root restarting its services under the new device id afterwards. Everything below the
 * transports is real (bootstrap, op log, enrolment, carry-over); the login and enrol transports are
 * fakes, as in live-shell-push.test.tsx.
 */
import { act } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

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
  createUuidV7Generator,
  readDeviceId,
  readSyncState,
  type EnrollRequest,
  type EnrollResponse,
} from '@bolusi/core';
import { mulberry32, noblePort, randomBytes as prngBytes } from '@bolusi/test-support';
import { sql } from 'kysely';

import type { RootProps } from '../src/bootstrap/Root.js';
import { createAppEnrollment, type EnrollmentPlatform } from '../src/bootstrap/enrollment.js';
import { SecureStoreKeyStore } from '../src/ports/keystore.js';
import type { LoginResult } from '../src/screens/enrollment/model.js';
import { fire, textsIn } from '../../../packages/ui/test/render.js';
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
  waitUntil,
  type Fixture,
} from './live-shell-support.js';

const NOW = 1_726_000_000_000;

let fixture: Fixture | null = null;
let secureStore: Map<string, string>;

beforeEach(async () => {
  await closeClientDb();
  __resetHardwareBack();
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
});

/** The login and enrol answers for the fixture's own tenant and store, with its user as owner. */
function platformFor(target: Fixture, sent: EnrollRequest[]): EnrollmentPlatform {
  const login: LoginResult = {
    controlSession: 'bcs_test_control_session',
    tenantId: target.tenantId,
    tenantName: 'Maju Group',
    user: { id: target.userId, name: 'Andi Pratama' },
    stores: [
      { id: target.storeId, name: 'Servis Ponsel Maju' },
      { id: '01920000-0000-7000-8000-0000000119b9', name: 'Servis Ponsel Sentani' },
    ],
  };
  const response = (body: EnrollRequest): EnrollResponse => ({
    deviceId: body.deviceId,
    deviceToken: 'bdt_new_registration',
    tenant: { id: target.tenantId, name: 'Maju Group' },
    store: { id: target.storeId, name: 'Servis Ponsel Maju' },
    settings: { idleLockSeconds: 300 },
    bundle: {
      tenant: { id: target.tenantId, name: 'Maju Group' },
      store: { id: target.storeId, name: 'Servis Ponsel Maju' },
      settings: { idleLockSeconds: 300 },
      users: [
        {
          id: target.userId,
          name: 'Andi Pratama',
          photoMediaId: null,
          status: 'active',
          grants: [{ roleId: 'role-owner', storeId: null }],
          pinVerifier: null,
        },
      ],
      rolesSnapshot: [
        {
          id: 'role-owner',
          name: 'main_owner',
          scopeType: 'tenant',
          isSystemDefault: true,
          permissionIds: [],
        },
      ],
      permissionsSnapshot: [],
    },
    bundleEtag: 'etag-reenrolled',
    serverTime: NOW,
  });
  const prng = mulberry32(0x77);
  return {
    loginTransport: { login: () => Promise.resolve(login) },
    enrollTransport: {
      enroll: (_controlSession: string, _idempotencyKey: string, body: EnrollRequest) => {
        sent.push(body);
        return Promise.resolve(response(body));
      },
    },
    keystore: new SecureStoreKeyStore(),
    crypto: noblePort,
    clock: { now: () => NOW },
    idSource: createUuidV7Generator({ now: () => NOW, randomBytes: (n) => prngBytes(prng, n) }),
    location: { getBestFix: () => null },
    platform: 'android',
    appVersion: '1.0.0',
  };
}

test('a phone the server forgot is registered again from the sync screen, and its unsent changes go with it', async () => {
  fixture = await bootFixture();
  const target = fixture;
  await enrolledDevice(target);
  await seedDirectory(target);
  // The original enrolment left this phone's signing seed in SecureStore.
  await new SecureStoreKeyStore().persistDevicePrivateKey(new Uint8Array(32).fill(7));
  // The server stopped recognising this phone, so the loop switched sync off with that reason.
  await sql`UPDATE sync_state SET sync_disabled = 1, sync_disabled_reason = 'device_unrecognised'`.execute(
    target.app.db.db,
  );

  const sent: EnrollRequest[] = [];
  const createEnrollment: RootProps['createEnrollment'] = (app, onEnrolled) =>
    createAppEnrollment(app, platformFor(target, sent), onEnrolled);
  const screen = await mountRoot(target, { createEnrollment });

  // Work goes on: the switcher and a PIN still open the shell. The unlock itself is a change the
  // server has not seen yet.
  fireOn(screen, `switcher-user-${target.userId}`);
  await settle();
  expect(await submitPin(screen, TEST_PIN)).toBe(true);

  fire(screen.get('ui.syncChip'), 'onPress');
  await waitUntil(() => screen.query('sync-status-screen') !== null);
  expect(screen.query('sync-unrecognised')).not.toBeNull();
  expect(screen.query('sync-now')).toBeNull();

  fireOn(screen, 'sync-reenroll');
  await waitUntil(() => screen.query('enrollment-screen') !== null);

  fire(screen.get('enroll-identifier.field'), 'onChangeText', 'andi');
  fire(screen.get('enroll-password.field'), 'onChangeText', 'Owner1PasswordBase58');
  await settle();
  fireOn(screen, 'enroll-submit');
  await waitUntil(() => screen.query('enroll-device-name') !== null);

  // The account has two stores, but the phone holds this one's data, so only this one is offered.
  expect(screen.query(`enroll-store-${target.storeId}`)).not.toBeNull();
  expect(screen.query('enroll-store-01920000-0000-7000-8000-0000000119b9')).toBeNull();
  // The owner sees whose changes will be carried over before binding.
  expect(textsIn(screen.get(`enroll-unsynced-${target.userId}`))).toContain('Andi Pratama');

  fire(screen.get('enroll-device-name.field'), 'onChangeText', 'Konter Depan');
  await settle();
  fireOn(screen, 'enroll-bind');
  await waitUntil(() => screen.query('enroll-step-done') !== null);
  fireOn(screen, 'enroll-finish');
  await waitUntil(() => screen.query('switcher-screen') !== null);

  const db = target.app.db.db;
  const newDeviceId = await readDeviceId(db);
  expect(newDeviceId).not.toBe(target.deviceId);
  // A forgotten registration has nothing on the server to replace.
  expect(sent).toHaveLength(1);
  expect(sent[0]?.storeId).toBe(target.storeId);
  expect(sent[0]).not.toHaveProperty('replacesDeviceId');

  const ops = await sql<{ deviceId: string; type: string; userId: string }>`
    SELECT device_id AS "deviceId", type, user_id AS "userId" FROM operations
    WHERE sync_status = 'local' ORDER BY seq
  `.execute(db);
  // Everything waiting to be sent now belongs to the new registration: its genesis, the transfer
  // record, then the carried changes, still credited to the employee who made them.
  expect(ops.rows.every((op) => op.deviceId === newDeviceId)).toBe(true);
  expect(ops.rows.slice(0, 2).map((op) => op.type)).toEqual([
    'auth.device_enrolled',
    'auth.device_changes_transferred',
  ]);
  expect(ops.rows.slice(2).length).toBeGreaterThan(0);
  expect(ops.rows.slice(2).every((op) => op.userId === target.userId)).toBe(true);

  expect(await readSyncState(db)).toMatchObject({ syncDisabled: false, syncDisabledReason: null });

  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
});
