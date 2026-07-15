// Device enrollment flow logic (api/02-auth §4.1): the step order, the bundle-before-command
// bootstrap rule (02-permissions §6), the crash-retry Idempotency-Key reuse (§4.3), and that
// enrollment logs nobody in (§4.4). Real client DB, real command runtime for the genesis op.
import { afterEach, describe, expect, it } from 'vitest';

import type { ClientDatabase, DbDriver } from '@bolusi/db-client';
import { mulberry32, noblePort, randomBytes as prngBytes } from '@bolusi/test-support';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

import {
  assemblePermissionRegistry,
  authOperationRegistry,
  changePinCommand,
  CommandRuntime,
  createDirectorySource,
  createUuidV7Generator,
  DomainError,
  PermissionEvaluator,
  readTenantId,
  runEnrollment,
  type DeviceBundle,
  type DeviceIdentity,
  type EnrollmentDeps,
  type EnrollmentParams,
  type EnrollRequest,
  type EnrollResponse,
  type KeyStorePort,
} from '../../src/index.js';
import { MAIN_OWNER_IDS, V0_MODULES } from '../authz/_fixtures.js';
import { makeFakeClock } from '../oplog/_fixtures.js';
import { createSqliteOpStore, FakeKeyStore, openFreshClientDb } from './_harness.js';

const START = 1_726_000_000_000;

/** Records the Idempotency-Key + whether the private key was already stored when the POST arrived. */
class FakeEnrollTransport {
  readonly calls: {
    idempotencyKey: string;
    body: EnrollRequest;
    privateKeyPresentAtCall: boolean;
  }[] = [];
  constructor(
    private readonly keystore: FakeKeyStore,
    private readonly build: (body: EnrollRequest) => EnrollResponse,
  ) {}
  enroll(
    _controlSession: string,
    idempotencyKey: string,
    body: EnrollRequest,
  ): Promise<EnrollResponse> {
    this.calls.push({ idempotencyKey, body, privateKeyPresentAtCall: this.keystore.hasPrivateKey });
    return Promise.resolve(this.build(body));
  }
}

/** A keystore that throws on the FIRST persistDeviceToken — the "crash between response and token". */
class CrashOnceKeyStore implements KeyStorePort {
  #crashed = false;
  constructor(private readonly inner: FakeKeyStore) {}
  persistDevicePrivateKey(seed: Uint8Array): Promise<void> {
    return this.inner.persistDevicePrivateKey(seed);
  }
  persistDeviceToken(token: string): Promise<void> {
    if (!this.#crashed) {
      this.#crashed = true;
      return Promise.reject(new Error('crash: process died before token persist'));
    }
    return this.inner.persistDeviceToken(token);
  }
  loadDeviceToken(): Promise<string | null> {
    return this.inner.loadDeviceToken();
  }
  loadSigningKey(): Promise<Uint8Array | null> {
    return this.inner.loadSigningKey();
  }
  getSigningKey(): Uint8Array {
    return this.inner.getSigningKey();
  }
  wipe(): Promise<void> {
    return this.inner.wipe();
  }
}

interface Fixture {
  readonly db: Kysely<ClientDatabase>;
  readonly driver: DbDriver;
  readonly keystore: FakeKeyStore;
  readonly transport: FakeEnrollTransport;
  readonly evaluator: PermissionEvaluator;
  readonly deps: EnrollmentDeps<ClientDatabase>;
  readonly params: EnrollmentParams;
  readonly ownerId: string;
  readonly tenantId: string;
  runtime(): CommandRuntime | null;
  genesisRuntimeBuilt(): boolean;
  close(): Promise<void>;
}

async function fixture(seed: number, keystore?: KeyStorePort): Promise<Fixture> {
  const { driver, db } = await openFreshClientDb();
  const clock = makeFakeClock(START);
  const prng = mulberry32(seed);
  const idSource = createUuidV7Generator({
    now: () => clock.now(),
    randomBytes: (n) => prngBytes(prng, n),
  });
  const idGen = createUuidV7Generator({ now: () => START, randomBytes: (n) => prngBytes(prng, n) });
  const tenantId = idGen();
  const storeId = idGen();
  const ownerId = idGen();
  const roleId = idGen();

  const fakeKeystore = new FakeKeyStore();
  const usedKeystore = keystore ?? fakeKeystore;

  const bundle: DeviceBundle = {
    tenant: { id: tenantId, name: 'Bolusi Papua' },
    store: { id: storeId, name: 'Toko Jayapura' },
    settings: { idleLockSeconds: 300 },
    users: [
      {
        id: ownerId,
        name: 'Ocep',
        photoMediaId: null,
        status: 'active',
        grants: [{ roleId, storeId: null }],
        pinVerifier: null,
      },
    ],
    rolesSnapshot: [
      {
        id: roleId,
        name: 'main_owner',
        scopeType: 'tenant',
        isSystemDefault: true,
        permissionIds: MAIN_OWNER_IDS,
      },
    ],
    permissionsSnapshot: [],
  };
  const transport = new FakeEnrollTransport(fakeKeystore, (body) => ({
    deviceId: body.deviceId,
    deviceToken: 'bdt_secret_token',
    tenant: bundle.tenant,
    store: bundle.store,
    settings: bundle.settings,
    bundle,
    bundleEtag: 'etag-1',
    serverTime: START,
  }));

  const evaluator = new PermissionEvaluator(
    assemblePermissionRegistry(V0_MODULES),
    createDirectorySource(db),
  );

  let builtRuntime: CommandRuntime | null = null;
  const runtimeFor = (device: DeviceIdentity): CommandRuntime => {
    // Called only for the genesis emit — which enrollment runs AFTER applyBundle (enrollment.ts code
    // order). The test also asserts the directory is populated post-run, so genesis-after-persist is
    // pinned from both ends.
    builtRuntime = new CommandRuntime({
      device,
      evaluator,
      operations: authOperationRegistry,
      store: createSqliteOpStore(driver, db),
      crypto: noblePort,
      clock: { now: () => clock.now() },
      idSource,
      location: { getBestFix: () => null },
      signingKey: usedKeystore,
      queryExecutor: { execute: () => Promise.resolve(undefined as never) },
      applyProjection: () => undefined,
      syncScheduler: { schedule: () => undefined },
    });
    return builtRuntime;
  };

  const deps: EnrollmentDeps<ClientDatabase> = {
    db,
    crypto: noblePort,
    idSource,
    keystore: usedKeystore,
    transport,
    runtimeFor,
  };
  const params: EnrollmentParams = {
    ownerUserId: ownerId,
    controlSession: 'bcs_control',
    storeId,
    deviceName: 'Kasir 1',
    platform: 'android',
    appVersion: '1.0.0',
  };

  return {
    db,
    driver,
    keystore: fakeKeystore,
    transport,
    evaluator,
    deps,
    params,
    ownerId,
    tenantId,
    runtime: () => builtRuntime,
    genesisRuntimeBuilt: () => builtRuntime !== null,
    close: async () => {
      await db.destroy();
      await driver.close();
    },
  };
}

let fx: Fixture | null = null;
afterEach(async () => {
  await fx?.close();
  fx = null;
});

async function countUsers(db: Kysely<ClientDatabase>): Promise<number> {
  const rows = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM users_directory`.execute(db);
  return Number(rows.rows[0]?.n ?? 0);
}

describe('enrollment flow (api/02-auth §4.1)', () => {
  it('persists the private seed BEFORE the POST, then token → bundle → genesis, in that order', async () => {
    fx = await fixture(1);
    const result = await runEnrollment(fx.deps, fx.params);

    // The private key was in the keystore when the enroll POST was made (§4.1 step 1 precedes step 3).
    expect(fx.transport.calls).toHaveLength(1);
    expect(fx.transport.calls[0]!.privateKeyPresentAtCall).toBe(true);
    // Keystore write order: private key first, token second.
    expect(fx.keystore.writes).toEqual(['device_private_key', 'device_token']);
    expect(fx.keystore.token).toBe('bdt_secret_token');

    // The bundle landed in the directory tables (users populated, tenant in meta_kv).
    expect(await countUsers(fx.db)).toBe(1);
    expect(await readTenantId(fx.db)).toBe(fx.tenantId);

    // The genesis op: seq 1, auth.device_enrolled, userId = the enrolling owner, appended AFTER the
    // directory persist (the runtime for it was built — enrollment.ts orders applyBundle first).
    expect(fx.genesisRuntimeBuilt()).toBe(true);
    const ops = await fx.db.selectFrom('operations').selectAll().execute();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.seq).toBe(1);
    expect(ops[0]!.type).toBe('auth.device_enrolled');
    expect(ops[0]!.userId).toBe(fx.ownerId);
    expect(ops[0]!.previousHash).toBe('0'.repeat(64));
    const payload = JSON.parse(ops[0]!.payload) as {
      storeId: string;
      deviceName: string;
      devicePublicKeyB64: string;
    };
    expect(payload.storeId).toBe(fx.params.storeId);
    expect(payload.deviceName).toBe('Kasir 1');
    expect(payload.devicePublicKeyB64.length).toBeGreaterThan(0);
    expect(result.deviceId).toBe(ops[0]!.deviceId);
  });

  it('logs nobody in — no session is opened (§4.4)', async () => {
    fx = await fixture(2);
    const result = await runEnrollment(fx.deps, fx.params);
    expect(result.loggedIn).toBe(false);
    const switches = await fx.db
      .selectFrom('operations')
      .selectAll()
      .where('type', '=', 'auth.user_switched')
      .execute();
    expect(switches, 'enrollment opens no session').toHaveLength(0);
  });

  it('bundle-before-command bootstrap: the first command is answered from the directory rows (§6)', async () => {
    fx = await fixture(3);
    await runEnrollment(fx.deps, fx.params);
    // The evaluator primes from the directory the enrollment just persisted.
    await fx.evaluator.prime();
    const runtime = fx.runtime()!;

    // ALLOW: the enrolled owner (main_owner) changing their own PIN — answered from their grant rows.
    const outcome = await runtime.execute(
      changePinCommand,
      { targetUserId: fx.ownerId, verifierRef: fx.deps.idSource() },
      runtime.createContext(fx.ownerId),
    );
    expect(outcome.ops[0]!.status).toBe('appended');

    // DENY: a user absent from the directory — fail closed, answered from directory rows.
    const stranger = fx.deps.idSource();
    const err = await runtime
      .execute(
        changePinCommand,
        { targetUserId: stranger, verifierRef: fx.deps.idSource() },
        runtime.createContext(stranger),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('PERMISSION_DENIED');
  });
});

describe('enrollment crash-retry (api/02-auth §4.3)', () => {
  it('a crash between the response and token persist → retry reuses the SAME Idempotency-Key', async () => {
    const inner = new FakeKeyStore();
    const crashing = new CrashOnceKeyStore(inner);
    fx = await fixture(4, crashing);

    // First attempt crashes at persistDeviceToken.
    await expect(runEnrollment(fx.deps, fx.params)).rejects.toThrow(/crash/);
    expect(fx.transport.calls).toHaveLength(1);

    // Retry: the draft persisted before the POST makes the same key reused; no double keypair.
    const result = await runEnrollment(fx.deps, fx.params);
    expect(fx.transport.calls).toHaveLength(2);
    expect(fx.transport.calls[1]!.idempotencyKey).toBe(fx.transport.calls[0]!.idempotencyKey);
    expect(fx.transport.calls[1]!.body.deviceId).toBe(fx.transport.calls[0]!.body.deviceId);
    expect(inner.token).toBe('bdt_secret_token');
    // Exactly one genesis op — the retry did not append a second seq 1.
    const genesis = await fx.db
      .selectFrom('operations')
      .selectAll()
      .where('type', '=', 'auth.device_enrolled')
      .execute();
    expect(genesis).toHaveLength(1);
    expect(result.deviceId).toBe(genesis[0]!.deviceId);
  });
});
