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
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
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
import type {
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  SignedOperation,
} from '@bolusi/schemas';
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
import { createSyncClient } from '../src/bootstrap/sync-client.js';
import type { NetInfoPort } from '../src/bootstrap/triggers.js';
import { SecureStoreKeyStore } from '../src/ports/keystore.js';
import type { LoginResult } from '../src/screens/enrollment/model.js';
import { fire, textsIn } from '../../../packages/ui/test/render.js';
import { __resetHardwareBack } from './doubles/react-native.js';
import {
  bootFixture,
  closeClientDb,
  enrolledDevice,
  fakeAppState,
  fireCreateNote,
  fireOn,
  mountRoot,
  seedDirectory,
  settle,
  submitPin,
  TEST_PIN,
  virtualTimer,
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

/** The server, as far as sync sees it: it takes every pushed op and has nothing new to send. */
class FakeSyncServer {
  readonly pushed: SignedOperation[] = [];
  private serverSeq = 0;

  push(request: PushRequest): Promise<PushResponse> {
    this.pushed.push(...request.ops);
    return Promise.resolve({
      results: request.ops.map((op) => ({
        id: op.id,
        status: 'accepted' as const,
        serverSeq: (this.serverSeq += 1),
      })),
      serverTime: NOW,
    });
  }

  pull(request: PullRequest): Promise<PullResponse> {
    return Promise.resolve({
      ops: [],
      nextCursor: request.cursor,
      hasMore: false,
      serverTime: NOW,
    });
  }
}

const online: NetInfoPort = {
  subscribe(listener) {
    listener(true);
    return () => undefined;
  },
};

/** A real sync client over the fake server, one per registration Root starts it for. */
function syncFor(server: FakeSyncServer, built: string[]): RootProps['createSync'] {
  return (booted) => {
    if (booted.deviceId === null) return null;
    built.push(booted.deviceId);
    return createSyncClient({
      db: booted.db,
      deviceId: booted.deviceId,
      transport: server,
      bundle: { refresh: () => Promise.resolve('unchanged') },
      applyPulledOp: (op) => booted.engine.applyPulledOp(op),
      refoldRefused: (op) => booted.engine.refoldRefused(op),
      crypto: noblePort,
      clock: { now: () => NOW },
      timer: virtualTimer(),
      appState: fakeAppState(),
      netInfo: online,
      initialSyncState: booted.syncState,
    });
  };
}

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
  const server = new FakeSyncServer();
  const built: string[] = [];
  const createEnrollment: RootProps['createEnrollment'] = (app, onEnrolled) =>
    createAppEnrollment(app, platformFor(target, sent), onEnrolled);
  const screen = await mountRoot(target, {
    createEnrollment,
    createSync: syncFor(server, built),
  });

  // Work goes on: the switcher and a PIN still open the shell, and a note can be saved. None of it
  // reaches the server, which refuses this phone.
  fireOn(screen, `switcher-user-${target.userId}`);
  await settle();
  expect(await submitPin(screen, TEST_PIN)).toBe(true);
  fireCreateNote(screen);
  await settle();
  fire(screen.get('notes.editor.title.field'), 'onChangeText', 'Ganti LCD');
  fire(screen.get('notes.editor.save'), 'onPress');
  const db = target.app.db.db;
  const noteSaved = async () =>
    (
      await db
        .selectFrom('operations')
        .select('id')
        .where('type', '=', 'notes.note_created')
        .execute()
    ).length > 0;
  expect(await waitUntil(noteSaved)).toBe(true);
  await settle();

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

  const newDeviceId = await readDeviceId(db);
  expect(newDeviceId).not.toBe(target.deviceId);
  // A forgotten registration has nothing on the server to replace.
  expect(sent).toHaveLength(1);
  expect(sent[0]?.storeId).toBe(target.storeId);
  expect(sent[0]).not.toHaveProperty('replacesDeviceId');

  // The phone sends under its new registration at once, while the owner still reads the success
  // step: its genesis, the transfer record, then the carried note, still credited to its author.
  expect(await waitUntil(() => server.pushed.some((op) => op.type === 'notes.note_created'))).toBe(
    true,
  );
  expect(built).toEqual([target.deviceId, newDeviceId]);
  expect(server.pushed.every((op) => op.deviceId === newDeviceId)).toBe(true);
  expect(server.pushed.slice(0, 2).map((op) => op.type)).toEqual([
    'auth.device_enrolled',
    'auth.device_changes_transferred',
  ]);
  expect(server.pushed.find((op) => op.type === 'notes.note_created')?.userId).toBe(target.userId);
  expect(screen.query('enroll-step-done')).not.toBeNull();
  expect(await readSyncState(db)).toMatchObject({ syncDisabled: false, syncDisabledReason: null });

  // The session open before the bind ended with the old registration; the switcher follows.
  fireOn(screen, 'enroll-finish');
  await waitUntil(() => screen.query('switcher-screen') !== null);
  fireOn(screen, `switcher-user-${target.userId}`);
  await settle();
  expect(await submitPin(screen, TEST_PIN)).toBe(true);
  const unlock = await waitUntil(() =>
    server.pushed.some((op) => op.type === 'auth.user_switched' && op.deviceId === newDeviceId),
  );
  expect(unlock).toBe(true);
  // Nothing was ever signed under the old registration after it was replaced.
  const stranded = await sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM operations WHERE sync_status = 'local' AND device_id <> ${newDeviceId}
  `.execute(db);
  expect(Number(stranded.rows[0]?.n)).toBe(0);
  expect(server.pushed.every((op) => op.deviceId === newDeviceId)).toBe(true);

  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
});
