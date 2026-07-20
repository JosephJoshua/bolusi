// Device enrollment flow logic (api/02-auth §4.1): the step order, the bundle-before-command
// bootstrap rule (02-permissions §6), the crash-retry Idempotency-Key reuse (§4.3), and that
// enrollment logs nobody in (§4.4). Real client DB, real command runtime for the genesis op.
import { afterEach, describe, expect, it } from 'vitest';

import { createClientDialect, type ClientDatabase, type DbDriver } from '@bolusi/db-client';
import { mulberry32, noblePort, randomBytes as prngBytes } from '@bolusi/test-support';
import { CamelCasePlugin, Kysely, sql } from 'kysely';

import {
  applyBundle,
  assemblePermissionRegistry,
  authOperationRegistry,
  changePinCommand,
  CommandRuntime,
  createDirectorySource,
  createUuidV7Generator,
  DEVICE_ID_META_KEY,
  DomainError,
  PermissionEvaluator,
  readDeviceId,
  readStoreId,
  readTenantId,
  runEnrollment,
  STORE_ID_META_KEY,
  STORE_NAME_META_KEY,
  TENANT_NAME_META_KEY,
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

async function fixture(
  seed: number,
  keystore?: KeyStorePort,
  wrapDriver?: (driver: DbDriver) => DbDriver,
): Promise<Fixture> {
  const { driver, db: freshDb } = await openFreshClientDb();
  // A driver wrapper (crash injection) must sit UNDER the whole enrollment path — `deps.db`, the
  // evaluator's reads, and the op store — so build one Kysely over the effective driver and hand it
  // everywhere. `driver` (raw) stays exposed so a test can read back through a FRESH handle (T-14b).
  const effectiveDriver = wrapDriver ? wrapDriver(driver) : driver;
  const db = wrapDriver
    ? new Kysely<ClientDatabase>({
        dialect: createClientDialect(effectiveDriver),
        plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
      })
    : freshDb;
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
      store: createSqliteOpStore(effectiveDriver, db),
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

/** A fresh Kysely over an already-open driver — the "restart" read that proves persistence, not a
 *  handle-local cache (T-14b: "a test that only reads back in-process proves nothing"). */
function freshHandle(driver: DbDriver): Kysely<ClientDatabase> {
  return new Kysely<ClientDatabase>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });
}

/** Every `meta_kv` key currently present, ascending — the denominator (T-14), not a presence spot-check. */
async function metaKeys(db: Kysely<ClientDatabase>): Promise<string[]> {
  const rows = await sql<{ key: string }>`SELECT key FROM meta_kv ORDER BY key`.execute(db);
  return rows.rows.map((r) => r.key);
}

/**
 * A `DbDriver` that dies on the `meta_kv` draft delete — the crash injected BETWEEN the identity
 * writes and the draft delete (enrollment.ts's last two steps). Wrapping the driver puts the fault
 * UNDER the whole path (the I/O boundary the dialect calls per query), so it fires exactly once, at
 * the one `DELETE FROM meta_kv` enrollment issues.
 */
function crashOnDraftDelete(inner: DbDriver): DbDriver {
  return {
    execute: (statement, params) => {
      if (/delete\s+from\s+"?meta_kv"?/i.test(statement)) {
        return Promise.reject(new Error('crash: process died before the enrollment draft delete'));
      }
      return inner.execute(statement, params);
    },
    executeBatch: (commands) => inner.executeBatch(commands),
    prepare: (statement) => inner.prepare(statement),
    begin: () => inner.begin(),
    commit: () => inner.commit(),
    rollback: () => inner.rollback(),
    close: () => inner.close(),
  };
}

describe('device identity persistence (task 88; 10-db §9; api/02-auth §4.1/§7.4)', () => {
  it('persists deviceId + storeId to meta_kv, readable through a FRESH handle (T-14b restart)', async () => {
    fx = await fixture(11);
    const result = await runEnrollment(fx.deps, fx.params);

    // A brand-new Kysely over the same driver: what survives here is in the DB, not this handle's cache.
    const restarted = freshHandle(fx.driver);
    expect(await readDeviceId(restarted)).toBe(result.deviceId);
    // storeId comes from the ENROLL RESPONSE (response.store.id), which the fixture builds as the store param.
    expect(await readStoreId(restarted)).toBe(fx.params.storeId);
  });

  it('after enrollment meta_kv holds EXACTLY {storeName, tenantName, deviceId, storeId, tenantId} — the draft is spent (T-14)', async () => {
    // A presence spot-check would pass on a row that also wrote keys nobody declared; assert the whole
    // set. deviceId/storeId are task 88's; tenantId AND the store/tenant DISPLAY NAMES are applyBundle's
    // (task 109 moved the name persistence into bundle-apply, so a rename refreshes them); draft deleted.
    // Keys arrive ORDER BY key: the two `auth.*` names sort before deviceId/storeId/tenantId.
    fx = await fixture(12);
    await runEnrollment(fx.deps, fx.params);
    expect(await metaKeys(fx.db)).toStrictEqual([
      STORE_NAME_META_KEY,
      TENANT_NAME_META_KEY,
      DEVICE_ID_META_KEY,
      STORE_ID_META_KEY,
      'tenantId',
    ]);
    // The keys the two producers own — no draft, no undeclared key.
    expect([DEVICE_ID_META_KEY, STORE_ID_META_KEY]).toStrictEqual(['deviceId', 'storeId']);
    expect([STORE_NAME_META_KEY, TENANT_NAME_META_KEY]).toStrictEqual([
      'auth.storeName',
      'auth.tenantName',
    ]);
  });

  it('a crash on the draft delete leaves the identity DURABLE and the draft recoverable (ordering)', async () => {
    // The identity writes precede the draft delete, so a crash between them can never lose the
    // identity: deviceId/storeId are already committed AND the draft is still there (§4.3 recovery).
    fx = await fixture(13, undefined, crashOnDraftDelete);
    await expect(runEnrollment(fx.deps, fx.params)).rejects.toThrow(/before the enrollment draft/);

    const deviceId = fx.transport.calls[0]!.body.deviceId; // the id the POST carried = draft.deviceId
    const restarted = freshHandle(fx.driver);
    expect(await readDeviceId(restarted)).toBe(deviceId);
    expect(await readStoreId(restarted)).toBe(fx.params.storeId);
    // The draft is NOT gone (the delete never ran) — identity is recoverable from BOTH places. The
    // store/tenant names persisted by applyBundle (task 109), which runs BEFORE the draft delete, survive.
    expect(await metaKeys(restarted)).toStrictEqual([
      'auth.enrollment_draft',
      STORE_NAME_META_KEY,
      TENANT_NAME_META_KEY,
      DEVICE_ID_META_KEY,
      STORE_ID_META_KEY,
      'tenantId',
    ]);
  });

  it('a bundle refresh naming a DIFFERENT store does NOT rewrite storeId (§7.4 irreversible binding)', async () => {
    // The one judgement in task 88: storeId is written by enrollment, never by applyBundle — a
    // server-side bundle change must not silently re-bind the device's store (an operator round-trip
    // to undo, §7.4). If applyBundle ever wrote storeId, this goes red.
    fx = await fixture(14);
    await runEnrollment(fx.deps, fx.params);
    expect(await readStoreId(fx.db)).toBe(fx.params.storeId);

    const otherStore = fx.deps.idSource();
    const rebind: DeviceBundle = {
      tenant: { id: fx.tenantId, name: 'Bolusi Papua' },
      store: { id: otherStore, name: 'A Different Store' },
      settings: { idleLockSeconds: 300 },
      users: [],
      rolesSnapshot: [],
      permissionsSnapshot: [],
    };
    await applyBundle(fx.db, rebind);

    expect(await readStoreId(fx.db)).toBe(fx.params.storeId); // unchanged — the binding held
    expect(otherStore).not.toBe(fx.params.storeId); // control: the refresh really named a new store
  });
});
