// The mobile enrollment E2E — the HEADLESS CEILING (api/02-auth §4.1).
//
// This drives the REAL enrollment path a device takes, end to end, with everything real except the
// two legs that need a server or a device:
//   REAL: `bootstrap()` (SQLCipher key → open → migrate → register → sync state) over a REAL migrated
//         client DB (better-sqlite3 behind the real dialect); the REAL command-runtime composition
//         (runtime.ts) and the REAL production op store; core's REAL `runEnrollment` (draft → POST →
//         token → bundle → genesis → deviceId persist → draft delete); REAL noble Ed25519 signing;
//         REAL `applyBundle` into the directory tables; REAL `meta_kv` persistence (task 88).
//   FAKED: the login + enroll TRANSPORTS (no server) and — via better-sqlite3 — SQLCipher at rest.
//
// So a green here proves the composition works: a production device that reaches these transports
// enrolls, writes a signed genesis at seq 1, persists its identity, and hands Root the deviceId that
// starts the loop. What it does NOT prove is the on-device/on-server leg (a real `POST`, a real
// SQLCipher file) — that is owed to task 27a (D12/D13). sync-client.ts / bootstrap.ts state the same
// boundary; this file does not overclaim past it.
//
// FALSIFIED (§2.11): breaking the signing key the runtime uses turns "the genesis verifies" RED;
// breaking the `meta_kv` deviceId write turns "the device is enrolled" RED and (in Root) the loop
// never starts. Reported in the task, not asserted here.
import {
  base64ToBytes,
  bytesToBase64,
  createUuidV7Generator,
  ENROLLMENT_DRAFT_KEY,
  readDeviceId,
  readStoreId,
  verifyOp,
  writeMeta,
  type DeviceBundle,
  type EnrollRequest,
  type EnrollResponse,
  type LocationPort,
} from '@bolusi/core';
import { GENESIS_PREVIOUS_HASH, type SignedOperation } from '@bolusi/schemas';
import {
  mulberry32,
  noblePort,
  randomBytes as prngBytes,
  nodeColumnAead,
} from '@bolusi/test-support';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { LoginResult } from '../screens/enrollment/model.js';

vi.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
    setItemAsync: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    getItemAsync: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    deleteItemAsync: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
  };
});

import * as SecureStore from 'expo-secure-store';

import { bootstrap, type Bootstrapped } from './bootstrap.js';
import { readDeviceInfo } from './device-info.js';
import { createAppEnrollment, type EnrollmentPlatform } from './enrollment.js';
import { SecureStoreKeyStore } from '../ports/keystore.js';
import { SecureStoreDbKeyStore } from '../ports/db-keystore.js';
import { openBetterSqlite3Driver } from '../../test/better-sqlite3-driver.js';

// The location port is stubbed inline (null fix) rather than importing `../ports/location.js`, which
// pulls in the native `expo-location` — the runtime only needs `getBestFix()`, non-blocking (04 §5.1).
const nullLocation: LocationPort = { getBestFix: () => null };

const FIXED_NOW = 1_726_000_000_000;
const clock = { now: () => FIXED_NOW };

// A CSPRNG stand-in: deterministic per run (T-6) but DIFFERENT on every call, so a key/id "reused"
// bug cannot pass by accident (the bootstrap.test.ts lesson: a constant fake makes equality vacuous).
let nonce = 0;
const dbFakeCrypto = {
  randomBytes: (length: number) => {
    nonce += 1;
    return Uint8Array.from({ length }, (_, i) => (i * 7 + nonce * 31 + 3) & 0xff);
  },
} as unknown as Parameters<typeof bootstrap>[0]['crypto'];

let app: Bootstrapped;

beforeEach(async () => {
  nonce = 0;
  app = await bootstrap({
    driverFactory: openBetterSqlite3Driver,
    keyStore: new SecureStoreDbKeyStore(dbFakeCrypto),
    aead: nodeColumnAead,
    crypto: dbFakeCrypto,
    clock,
    databaseLocation: ':memory:',
  });
});

afterEach(async () => {
  await app.close();
  // Reset the mocked SecureStore between tests — the mock's backing Map lives in module scope, so a
  // seed/token persisted by one test would leak into the next (a determinism hole, T-6).
  await SecureStore.deleteItemAsync('bolusi.device_private_key');
  await SecureStore.deleteItemAsync('bolusi.device_token');
  vi.clearAllMocks();
});

/** A seeded id source (deviceId + idempotency key) — deterministic per seed (T-6). */
function seededIdSource(seed: number): () => string {
  const prng = mulberry32(seed);
  return createUuidV7Generator({
    now: () => FIXED_NOW,
    randomBytes: (n: number) => prngBytes(prng, n),
  });
}

const OWNER_ID = '00000000-0000-4000-8000-00000000a001';
const TENANT_ID = '00000000-0000-4000-8000-00000000b001';
const STORE_ID = '00000000-0000-4000-8000-00000000c001';
const ROLE_ID = '00000000-0000-4000-8000-00000000d001';

function loginResult(): LoginResult {
  return {
    controlSession: 'bcs_test_control_session',
    tenantId: TENANT_ID,
    tenantName: 'Bolusi Papua',
    user: { id: OWNER_ID, name: 'Ocep' },
    stores: [{ id: STORE_ID, name: 'Toko Jayapura' }],
  };
}

function deviceBundle(): DeviceBundle {
  return {
    tenant: { id: TENANT_ID, name: 'Bolusi Papua' },
    store: { id: STORE_ID, name: 'Toko Jayapura' },
    settings: { idleLockSeconds: 300 },
    users: [
      {
        id: OWNER_ID,
        name: 'Ocep',
        photoMediaId: null,
        status: 'active',
        grants: [{ roleId: ROLE_ID, storeId: null }],
        pinVerifier: null,
      },
    ],
    rolesSnapshot: [
      {
        id: ROLE_ID,
        name: 'main_owner',
        scopeType: 'tenant',
        isSystemDefault: true,
        permissionIds: [],
      },
    ],
    permissionsSnapshot: [],
  };
}

function enrollResponse(): EnrollResponse {
  return {
    deviceId: 'server-echoes-the-client-id', // runEnrollment uses the CLIENT draft id, not this
    deviceToken: 'bdt_test_device_token',
    tenant: { id: TENANT_ID, name: 'Bolusi Papua' },
    store: { id: STORE_ID, name: 'Toko Jayapura' },
    settings: { idleLockSeconds: 300 },
    bundle: deviceBundle(),
    bundleEtag: 'etag-1',
    serverTime: FIXED_NOW,
  };
}

/** A recording fake transport pair — zero sockets. Captures the enroll body for key verification. */
function fakeTransports() {
  const enrollBodies: EnrollRequest[] = [];
  return {
    enrollBodies,
    loginTransport: { login: (): Promise<LoginResult> => Promise.resolve(loginResult()) },
    enrollTransport: {
      enroll: (_session: string, _key: string, body: EnrollRequest): Promise<EnrollResponse> => {
        enrollBodies.push(body);
        return Promise.resolve(enrollResponse());
      },
    },
  };
}

function platformFor(overrides: Partial<EnrollmentPlatform> = {}): {
  platform: EnrollmentPlatform;
  keystore: SecureStoreKeyStore;
  enrollBodies: EnrollRequest[];
} {
  const keystore = new SecureStoreKeyStore();
  const transports = fakeTransports();
  const platform: EnrollmentPlatform = {
    loginTransport: transports.loginTransport,
    enrollTransport: transports.enrollTransport,
    keystore,
    crypto: noblePort,
    clock,
    idSource: seededIdSource(0x51),
    location: nullLocation,
    platform: 'android',
    appVersion: '1.0.0',
    ...overrides,
  };
  return { platform, keystore, enrollBodies: transports.enrollBodies };
}

/** The single genesis op row, reconstructed into a `SignedOperation`. */
async function genesisOp(): Promise<SignedOperation | undefined> {
  const rows = await app.db.db.selectFrom('operations').selectAll().orderBy('seq', 'asc').execute();
  const r = rows[0];
  if (r === undefined) return undefined;
  return {
    id: r.id as string,
    tenantId: r.tenantId,
    storeId: r.storeId,
    userId: r.userId,
    deviceId: r.deviceId,
    seq: r.seq,
    type: r.type,
    entityType: r.entityType,
    entityId: r.entityId,
    schemaVersion: r.schemaVersion,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    timestamp: r.timestampMs,
    location: r.location === null ? null : (JSON.parse(r.location) as SignedOperation['location']),
    source: r.source as SignedOperation['source'],
    agentInitiated: r.agentInitiated === 1,
    agentConversationId: r.agentConversationId,
    previousHash: r.previousHash,
    hash: r.hash,
    signature: r.signature,
  };
}

test('login returns the LoginResult the wizard renders, including the tenant name', async () => {
  const { platform } = platformFor();
  const { controller } = createAppEnrollment(app, platform, () => undefined);
  const result = await controller.login({
    loginIdentifier: 'ocep',
    password: 'Owner1PasswordBase58',
  });
  expect(result.tenantName).toBe('Bolusi Papua');
  expect(result.stores).toEqual([{ id: STORE_ID, name: 'Toko Jayapura' }]);
});

test('enroll appends a signed genesis at seq 1, persists the device identity, and signals onEnrolled', async () => {
  const { platform, enrollBodies } = platformFor();
  let enrolledWith: string | null = null;
  const { controller } = createAppEnrollment(app, platform, (deviceId) => {
    enrolledWith = deviceId;
  });

  await controller.enroll({ login: loginResult(), storeId: STORE_ID, deviceName: 'Kasir 1' });

  // The device is enrolled: `meta_kv` holds the id (task 88) — the boot signal that gates the loop.
  const deviceId = await readDeviceId(app.db.db);
  expect(deviceId).not.toBeNull();
  expect(enrolledWith).toBe(deviceId); // onEnrolled fired AFTER the persist, with the real id
  expect(await readStoreId(app.db.db)).toBe(STORE_ID); // from the enroll RESPONSE (§7.4 binding)

  // The genesis op: seq 1, chained from 64 zeros, entityId = the device's own id (05 §9.5).
  const genesis = await genesisOp();
  expect(genesis).toBeDefined();
  const op = genesis as SignedOperation;
  expect(op.seq).toBe(1);
  expect(op.type).toBe('auth.device_enrolled');
  expect(op.entityId).toBe(deviceId);
  expect(op.previousHash).toBe(GENESIS_PREVIOUS_HASH);
  expect(op.userId).toBe(OWNER_ID);

  // It is signed with THE DEVICE's key — the one whose public half was sent to the server. This is
  // the §2.5 crown jewel end to end: the genesis carries a real signature by the enrolled key.
  const body = enrollBodies[0];
  expect(body).toBeDefined();
  const publicKey = base64ToBytes((body as EnrollRequest).devicePublicKeyB64);
  expect(verifyOp(op, publicKey, noblePort)).toBe(true);
  // …and tampering breaks it (the signature covers the whole core).
  expect(verifyOp({ ...op, payload: { evil: true } }, publicKey, noblePort)).toBe(false);

  // The directory was written BEFORE the genesis (§4.1 step 4) — the owner is switcher-visible.
  const users = await app.db.db.selectFrom('usersDirectory').select(['id', 'name']).execute();
  expect(users).toEqual([{ id: OWNER_ID, name: 'Ocep' }]);
});

test('enroll persists the device/store/tenant NAMES → readDeviceInfo surfaces the real identity (task 94)', async () => {
  // The production wire the Settings screen depends on: core's `applyBundle` (run by `runEnrollment`)
  // persists the store/tenant names from the enroll bundle (task 109), and enrollment.ts persists the
  // owner-typed deviceName — so a later boot (and the live re-derive) reads a real identity, not the
  // blank index.ts used to hand in. Reverting enrollment.ts's `persistEnrolledNames` call turns
  // deviceName blank; breaking `applyBundle`'s name write turns store/tenant blank — either is RED here.
  const { platform } = platformFor();
  const { controller } = createAppEnrollment(app, platform, () => undefined);

  await controller.enroll({ login: loginResult(), storeId: STORE_ID, deviceName: 'Kasir 1' });

  const info = await readDeviceInfo(app, { platform: 'android', appVersion: '' });
  const deviceId = await readDeviceId(app.db.db);
  expect(info.deviceId).toBe(deviceId); // the same id the genesis + POST + meta_kv carry
  expect(info.deviceName).toBe('Kasir 1'); // what the owner typed in the wizard (persistEnrolledNames)
  expect(info.storeName).toBe('Toko Jayapura'); // from the enroll bundle via core's applyBundle (task 109)
  expect(info.tenantName).toBe('Bolusi Papua'); // from the enroll bundle via core's applyBundle (task 109)
  expect([info.deviceId, info.deviceName, info.storeName, info.tenantName]).not.toContain('');
});

test('the enroll POST carries the client-generated identity, not the server-echoed one', async () => {
  const { platform, enrollBodies } = platformFor();
  const { controller } = createAppEnrollment(app, platform, () => undefined);
  await controller.enroll({ login: loginResult(), storeId: STORE_ID, deviceName: 'Kasir 1' });

  const body = enrollBodies[0] as EnrollRequest;
  const deviceId = await readDeviceId(app.db.db);
  // The device id is the client's UUIDv7 (SEC-DEV-05: generated on-device), echoed in the genesis,
  // the POST body, and meta_kv — one id, three places, never the response's placeholder.
  expect(body.deviceId).toBe(deviceId);
  expect(body.storeId).toBe(STORE_ID);
  expect(body.platform).toBe('android');
});

test('RESUME after crash-before-genesis: a FRESH keystore reloads the seed and completes enrollment', async () => {
  // THE REGRESSION (review-92 HIGH). The crash window (§4.3): the first attempt persisted the private
  // seed to SecureStore and wrote the enrollment draft, then the app was KILLED before the seq-1
  // genesis. On restart `index.ts` rebuilds `new SecureStoreKeyStore()` with an EMPTY in-memory cache.
  // Before the fix, the retry's genesis emit called `getSigningKey()` on that empty cache and threw
  // "device signing key not loaded" BEFORE `deviceId` persisted — `classifyFailure` bucketed the
  // status-less error as `offline`, and every retry repeated: a permanently un-enrollable device.
  //
  // Set up EXACTLY that persisted state, then resume with a fresh keystore.
  const prng = mulberry32(0x99);
  const ids = createUuidV7Generator({
    now: () => FIXED_NOW,
    randomBytes: (n) => prngBytes(prng, n),
  });
  const keypair = noblePort.ed25519Keygen(prngBytes(prng, 32));
  const draftDeviceId = ids();

  // (1) the seed sits in SecureStore, exactly as the first attempt's `persistDevicePrivateKey` left it
  //     (a throwaway keystore writes it; the resume controller below gets a SEPARATE, empty-cache one).
  await new SecureStoreKeyStore().persistDevicePrivateKey(keypair.secretKey);
  // (2) the draft is in meta_kv; its public key matches the persisted seed (as the first attempt wrote).
  await writeMeta(
    app.db.db,
    ENROLLMENT_DRAFT_KEY,
    JSON.stringify({
      deviceId: draftDeviceId,
      idempotencyKey: ids(),
      devicePublicKeyB64: bytesToBase64(keypair.publicKey),
    }),
  );
  // (3) NO deviceId meta, NO genesis op — the device is mid-enrollment, not enrolled.
  expect(await readDeviceId(app.db.db)).toBeNull();

  // THE RESTART: a fresh controller with a FRESH `SecureStoreKeyStore` (empty cache) — production shape.
  const { platform } = platformFor();
  let enrolledWith: string | null = null;
  const { controller } = createAppEnrollment(app, platform, (deviceId) => {
    enrolledWith = deviceId;
  });

  // The retry must COMPLETE — with the fix reverted this rejects "device signing key not loaded".
  await controller.enroll({ login: loginResult(), storeId: STORE_ID, deviceName: 'Kasir 1' });

  // The SAME device id from the draft is now enrolled — no fresh keypair, no double-register (§4.3).
  expect(await readDeviceId(app.db.db)).toBe(draftDeviceId);
  expect(enrolledWith).toBe(draftDeviceId);

  // The genesis was appended and is signed with the RESUMED seed — the one reloaded from SecureStore,
  // proving the resume branch restored the cache the synchronous signer reads.
  const genesis = await genesisOp();
  expect(genesis).toBeDefined();
  const op = genesis as SignedOperation;
  expect(op.seq).toBe(1);
  expect(op.entityId).toBe(draftDeviceId);
  expect(op.previousHash).toBe(GENESIS_PREVIOUS_HASH);
  expect(verifyOp(op, keypair.publicKey, noblePort)).toBe(true);
});
