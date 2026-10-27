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
  FIRST_PIN_USER_META_KEY,
  IDLE_LOCK_SECONDS_META_KEY,
  readMeta,
  base64ToBytes,
  completeDraft,
  markSyncResult,
  insertOpLogRow,
  operationFromSignedCoreJcs,
  readHeldPhone,
  readSyncState,
  verifyOp,
  PermissionEvaluator,
  readDeviceId,
  readIdleLockSeconds,
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
  /** The bundle the fake enroll response carries — asserted against what `applyBundle` persisted. */
  readonly bundle: DeviceBundle;
  readonly ownerId: string;
  readonly tenantId: string;
  runtime(): CommandRuntime | null;
  readonly refolded: string[];
  readonly clock: ReturnType<typeof makeFakeClock>;
  genesisRuntimeBuilt(): boolean;
  close(): Promise<void>;
}

async function fixture(
  seed: number,
  keystore?: KeyStorePort,
  wrapDriver?: (driver: DbDriver) => DbDriver,
  mutateBundle?: (bundle: DeviceBundle) => void,
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
  // Let a test perturb the bundle BEFORE the transport closes over it (task 179 falsification).
  mutateBundle?.(bundle);
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

  const refolded: string[] = [];
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
    // A REAL driver transaction (task 179) — the SAME begin/run/commit/rollback-on-throw SEMANTICS the
    // db-client's ClientDb.transaction runs (op-store.ts), adapted to EnrollmentDeps.transaction's
    // ZERO-ARG contract: `applyBundle` writes through `deps.db` (the shared connection, transactional
    // during begin..commit), so this runner does not surface the DbDriver ClientDb.transaction passes —
    // exactly as the refresh path passes `config.db.db`, not the driver, to applyBundle. Backed by the
    // fixture's real better-sqlite3 driver so the rollback is genuine, which the falsification needs.
    transaction: async (fn) => {
      await driver.begin();
      try {
        const result = await fn();
        await driver.commit();
        return result;
      } catch (error) {
        try {
          await driver.rollback();
        } catch {
          /* preserve the original error */
        }
        throw error;
      }
    },
    crypto: noblePort,
    idSource,
    keystore: usedKeystore,
    transport,
    runtimeFor,
    refold: (op) => {
      refolded.push(op.id);
      return Promise.resolve();
    },
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
    bundle,
    ownerId,
    tenantId,
    runtime: () => builtRuntime,
    refolded,
    clock,
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

/** Mark ops sent, the way a push answer does. */
async function markSynced(
  db: Kysely<ClientDatabase>,
  ops: readonly { id: string }[],
): Promise<void> {
  for (const op of ops) {
    await markSyncResult(db as never, {
      id: op.id,
      currentStatus: 'local',
      event: { kind: 'accepted', syncedAt: START },
    });
  }
}

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
    const payload = (JSON.parse(ops[0]!.signedCoreJcs) as { payload: unknown }).payload as {
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

  it('after enrollment meta_kv holds EXACTLY {firstPinUserId, idleLockSeconds, storeName, tenantName, deviceId, storeId, tenantId} — the draft is spent (T-14)', async () => {
    // A presence spot-check would pass on a row that also wrote keys nobody declared; assert the whole
    // set. deviceId/storeId are task 88's; tenantId, the store/tenant DISPLAY NAMES and (task 133) the
    // tenant's idleLockSeconds are applyBundle's — every one of them re-delivered on each refresh, so
    // a rename or a settings change reaches the device; draft deleted.
    // Keys arrive ORDER BY key: the three `auth.*` keys sort before deviceId/storeId/tenantId.
    fx = await fixture(12);
    await runEnrollment(fx.deps, fx.params);
    expect(await metaKeys(fx.db)).toStrictEqual([
      FIRST_PIN_USER_META_KEY,
      IDLE_LOCK_SECONDS_META_KEY,
      STORE_NAME_META_KEY,
      TENANT_NAME_META_KEY,
      DEVICE_ID_META_KEY,
      STORE_ID_META_KEY,
      'tenantId',
    ]);
    // The keys the two producers own — no draft, no undeclared key.
    expect([DEVICE_ID_META_KEY, STORE_ID_META_KEY]).toStrictEqual(['deviceId', 'storeId']);
    // The enrolling owner, the one user who may make their own first PIN here (pin-flows.ts).
    expect(await readMeta(fx.db, FIRST_PIN_USER_META_KEY)).toBe(fx.params.ownerUserId);
    expect([STORE_NAME_META_KEY, TENANT_NAME_META_KEY, IDLE_LOCK_SECONDS_META_KEY]).toStrictEqual([
      'auth.storeName',
      'auth.tenantName',
      'auth.idleLockSeconds',
    ]);
    // THE ENROLLED DEVICE HOLDS THE TENANT'S TIMEOUT FROM ITS FIRST MOMENT (§6.4). Before task 133
    // this key did not exist, so a device sat on the 300 s default until its first bundle refresh —
    // and `SessionManager` was constructed without the value at all, so it sat there forever.
    expect(await readIdleLockSeconds(fx.db)).toBe(fx.bundle.settings.idleLockSeconds);
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
      FIRST_PIN_USER_META_KEY,
      IDLE_LOCK_SECONDS_META_KEY,
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

describe('the enrolling owner’s own first PIN', () => {
  it('is only allowed when the server has no PIN for them', async () => {
    fx = await fixture(180, undefined, undefined, (bundle) => {
      (bundle.users[0] as { pinVerifier: unknown }).pinVerifier = {
        algorithm: 'argon2id',
        saltB64: 'MDEyMzQ1Njc4OWFiY2RlZg==',
        mKiB: 19456,
        t: 2,
        p: 1,
        hashB64: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
        asOf: { timestamp: 1, deviceId: '00000000-0000-0000-0000-000000000000', seq: 0 },
      };
    });
    await runEnrollment(fx.deps, fx.params);
    expect(await readMeta(fx.db, FIRST_PIN_USER_META_KEY)).toBeNull();
  });
});

describe('applyBundle atomicity on the enrollment path (task 179)', () => {
  it('a mid-apply verifier-bounds throw rolls back ALL directory + meta writes — no partial state', async () => {
    // `assertVerifierInBounds` (SEC-AUTH-01) runs LAST in applyBundle, AFTER the tenant/store/user/role
    // rows are written. A shape-valid but OUT-OF-BOUNDS verifier (mKiB = 1 GiB, over the [19456,65536]
    // ceiling) passes DeviceBundleSchema, then throws there. Before task 179 the enrollment caller ran
    // applyBundle bare, so tenantId + the user row survived that throw (a partial directory). The
    // transaction wrap must roll the whole apply back.
    fx = await fixture(179, undefined, undefined, (bundle) => {
      (bundle.users[0] as { pinVerifier: unknown }).pinVerifier = {
        algorithm: 'argon2id',
        saltB64: 'c2FsdHNhbHRzYWx0MTY=',
        mKiB: 1_048_576, // 1 GiB — over the SEC-AUTH-01 ceiling: shape-valid, bounds-invalid
        t: 3,
        p: 1,
        hashB64: 'aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaDMy',
        asOf: { timestamp: 1, deviceId: '00000000-0000-0000-0000-000000000000', seq: 0 },
      };
    });

    // The apply throws where the spec says it does — the DoS guard, mid-apply.
    await expect(runEnrollment(fx.deps, fx.params)).rejects.toThrow();

    // ROLLBACK, read through a FRESH handle (T-14b): nothing applyBundle wrote survives.
    expect(await countUsers(fx.db)).toBe(0);
    expect(await readTenantId(fx.db)).toBeNull();
    // T-14 denominator: none of applyBundle's four meta keys is present — not just the tenant one.
    const keys = await metaKeys(fx.db);
    expect(keys).not.toContain(STORE_NAME_META_KEY);
    expect(keys).not.toContain(TENANT_NAME_META_KEY);
    expect(keys).not.toContain(IDLE_LOCK_SECONDS_META_KEY);
  });
});

describe('re-enrolling a phone that still holds unsynced changes', () => {
  interface OpRowLite {
    id: string;
    deviceId: string;
    seq: number;
    type: string;
    userId: string;
    syncStatus: string;
    timestampMs: number;
    signedCoreJcs: string;
    hash: string;
    signature: string;
  }
  const allOps = async (db: Kysely<ClientDatabase>): Promise<OpRowLite[]> =>
    (await db
      .selectFrom('operations')
      .select([
        'id',
        'deviceId',
        'seq',
        'type',
        'userId',
        'syncStatus',
        'timestampMs',
        'signedCoreJcs',
        'hash',
        'signature',
      ])
      .orderBy('deviceId')
      .orderBy('seq')
      .execute()) as OpRowLite[];

  /** Enrol once, then save three changes as the owner on that registration; ops up to `sentUpToSeq` synced. */
  async function enrolledWithBacklog(seed: number, sentUpToSeq = 2) {
    const f = await fixture(seed);
    const first = await runEnrollment(f.deps, f.params);
    const runtime = f.runtime()!;
    for (let i = 0; i < 3; i += 1) {
      f.clock.advance(1_000);
      await runtime.emitRuntimeOp({
        type: 'auth.session_ended',
        entityType: 'auth_session',
        entityId: createUuidV7Generator({
          now: () => f.clock.now(),
          randomBytes: (n) => prngBytes(mulberry32(seed * 10 + i), n),
        })(),
        payload: { reason: 'manual_lock' },
        userId: f.ownerId,
      });
    }
    // The genesis and the first change reached the server; the other two did not.
    const before = await allOps(f.db);
    await markSynced(
      f.db,
      before.filter((op) => op.seq <= sentUpToSeq),
    );
    // The server stopped recognising the phone, so sync was switched off with that reason.
    await sql`UPDATE sync_state SET sync_disabled = 1, sync_disabled_reason = 'device_unrecognised',
      pull_cursor = 42, token_rejected_count = 4, token_rejected_since = 1`.execute(f.db);
    return { f, oldDeviceId: first.deviceId, before };
  }

  it('re-signs only the unsynced changes under the new device, after an audit record, keeping ids, authors and times', async () => {
    const { f, oldDeviceId, before } = await enrolledWithBacklog(41);
    fx = f;
    f.clock.advance(60_000);
    const second = await runEnrollment(f.deps, f.params);
    expect(second.deviceId).not.toBe(oldDeviceId);
    expect(second.carriedOver).toBe(2);

    const after = await allOps(f.db);
    const unsynced = before.filter((op) => op.seq >= 3);
    // Synced history is untouched, byte for byte.
    for (const op of before.filter((o) => o.seq <= 2)) {
      expect(after.find((row) => row.id === op.id)).toEqual({ ...op, syncStatus: 'synced' });
    }
    // The new chain: genesis, the audit record, then the carried changes in their old order.
    const chain = after.filter((op) => op.deviceId === second.deviceId);
    expect(chain.map((op) => [op.seq, op.type])).toEqual([
      [1, 'auth.device_enrolled'],
      [2, 'auth.device_changes_transferred'],
      [3, 'auth.session_ended'],
      [4, 'auth.session_ended'],
    ]);
    const audit = JSON.parse(chain[1]!.signedCoreJcs) as { userId: string; payload: unknown };
    expect(audit.userId).toBe(f.ownerId);
    expect(audit.payload).toEqual({ fromDeviceIds: [oldDeviceId], opCount: 2 });
    for (const [i, old] of unsynced.entries()) {
      const moved = chain[2 + i]!;
      expect(moved.id).toBe(old.id);
      expect(moved.userId).toBe(old.userId);
      expect(moved.timestampMs).toBe(old.timestampMs);
      expect(moved.syncStatus).toBe('local');
      expect(moved.hash).not.toBe(old.hash);
    }
    // Nothing is left on the old registration that still waits to be sent.
    expect(after.filter((op) => op.deviceId === oldDeviceId && op.syncStatus === 'local')).toEqual(
      [],
    );
    // Every op on the new chain verifies under the new key and links to the one before it.
    const publicKey = base64ToBytes(f.transport.calls.at(-1)!.body.devicePublicKeyB64);
    let previousHash = '0'.repeat(64);
    for (const row of chain) {
      const op = operationFromSignedCoreJcs(row.signedCoreJcs, row);
      expect(verifyOp(op, publicKey, noblePort)).toBe(true);
      expect(op.previousHash).toBe(previousHash);
      previousHash = op.hash;
    }
    // Each carried change's record was re-folded.
    expect(f.refolded).toEqual(unsynced.map((op) => op.id));
  });

  it('starts sync over for the new registration', async () => {
    const { f } = await enrolledWithBacklog(42);
    fx = f;
    await runEnrollment(f.deps, f.params);
    const state = await readSyncState(f.db);
    expect(state).toMatchObject({
      cursor: 0,
      syncDisabled: false,
      syncDisabledReason: null,
      pushHalted: false,
      tokenRejectedCount: 0,
      tokenRejectedSince: null,
    });
  });

  it('a phone with nothing unsynced gets no audit record', async () => {
    const { f } = await enrolledWithBacklog(43);
    fx = f;
    await markSynced(
      f.db,
      (await allOps(f.db)).filter((op) => op.syncStatus === 'local'),
    );
    const second = await runEnrollment(f.deps, f.params);
    expect(second.carriedOver).toBe(0);
    const types = (await allOps(f.db))
      .filter((op) => op.deviceId === second.deviceId)
      .map((op) => op.type);
    expect(types).toEqual(['auth.device_enrolled']);
  });

  it('drops the old registration’s unsent genesis instead of carrying it', async () => {
    // Nothing ever reached the server this time, the genesis included.
    const { f, oldDeviceId } = await enrolledWithBacklog(45, 0);
    fx = f;
    const second = await runEnrollment(f.deps, f.params);
    expect(second.carriedOver).toBe(3);
    const after = await allOps(f.db);
    expect(after.filter((op) => op.deviceId === oldDeviceId)).toEqual([]);
    expect(after.filter((op) => op.deviceId === second.deviceId).map((op) => op.type)).toEqual([
      'auth.device_enrolled',
      'auth.device_changes_transferred',
      'auth.session_ended',
      'auth.session_ended',
      'auth.session_ended',
    ]);
  });

  it('tells the owner which store the phone belongs to and whose changes are waiting', async () => {
    const empty = await fixture(46);
    fx = empty;
    expect(await readHeldPhone(empty.db)).toBeNull();
    await empty.close();

    const { f, oldDeviceId } = await enrolledWithBacklog(47);
    fx = f;
    expect(await readHeldPhone(f.db)).toEqual({
      storeId: f.params.storeId,
      storeName: 'Toko Jayapura',
      // Sync is off (the server forgot the phone), so there is no registration to replace.
      replacesDeviceId: null,
      unsynced: [{ userId: f.ownerId, name: 'Ocep', count: 2, types: ['auth.session_ended'] }],
    });
    await sql`UPDATE sync_state SET sync_disabled = 0, sync_disabled_reason = NULL`.execute(f.db);
    expect((await readHeldPhone(f.db))?.replacesDeviceId).toBe(oldDeviceId);
  });

  it('moves media refs and not-yet-uploaded photos to the new device', async () => {
    const { f, oldDeviceId } = await enrolledWithBacklog(44);
    fx = f;
    const mediaId = createUuidV7Generator({
      now: () => f.clock.now(),
      randomBytes: (n) => prngBytes(mulberry32(4401), n),
    })();
    const uploadedId = createUuidV7Generator({
      now: () => f.clock.now(),
      randomBytes: (n) => prngBytes(mulberry32(4402), n),
    })();
    // A change carrying a photo ref naming the old device, next on the old chain.
    const last = (await allOps(f.db)).filter((row) => row.deviceId === oldDeviceId).at(-1)!;
    f.clock.advance(1_000);
    const withRef = completeDraft(
      {
        type: 'auth.session_ended',
        entityType: 'auth_session',
        entityId: mediaId,
        schemaVersion: 1,
        payload: {
          reason: 'manual_lock',
          photo: { mediaId, deviceId: oldDeviceId, userId: f.ownerId },
        },
      },
      {
        id: createUuidV7Generator({
          now: () => f.clock.now(),
          randomBytes: (n) => prngBytes(mulberry32(4403), n),
        })(),
        tenantId: f.tenantId,
        storeId: f.params.storeId,
        userId: f.ownerId,
        deviceId: oldDeviceId,
        seq: last.seq + 1,
        previousHash: last.hash,
        timestamp: f.clock.now(),
        location: null,
      },
      f.keystore.getSigningKey(),
      noblePort,
    );
    await insertOpLogRow(
      f.db,
      { op: withRef.op, signedCoreJcs: withRef.jcs },
      { syncStatus: 'local', syncedAt: null, arrivalSeq: null },
    );
    const op = withRef.op;
    for (const [id, status] of [
      [mediaId, 'pending'],
      [uploadedId, 'uploaded'],
    ] as const) {
      await sql`INSERT INTO media_items (id, tenant_id, store_id, captured_by_user_id, device_id,
        type, mime_type, byte_size, sha256, captured_at, upload_status)
        VALUES (${id}, ${f.tenantId}, ${f.params.storeId}, ${f.ownerId}, ${oldDeviceId}, 'image',
          'image/jpeg', 10, ${'0'.repeat(64)}, 1, ${status})`.execute(f.db);
    }

    const second = await runEnrollment(f.deps, f.params);
    const moved = (await allOps(f.db)).find((row) => row.id === op.id)!;
    expect(moved.deviceId).toBe(second.deviceId);
    const payload = (JSON.parse(moved.signedCoreJcs) as { payload: { photo: unknown } }).payload;
    expect(payload.photo).toEqual({ mediaId, deviceId: second.deviceId, userId: f.ownerId });
    const media = await sql<{ id: string; deviceId: string }>`
      SELECT id, device_id AS "deviceId" FROM media_items ORDER BY id`.execute(f.db);
    expect(Object.fromEntries(media.rows.map((row) => [row.id, row.deviceId]))).toEqual({
      [mediaId]: second.deviceId,
      [uploadedId]: oldDeviceId,
    });
  });

  it('refuses to bind a phone holding one store’s data to another store, before calling the server', async () => {
    const { f } = await enrolledWithBacklog(45);
    fx = f;
    const calls = f.transport.calls.length;
    const otherStore = createUuidV7Generator({
      now: () => START,
      randomBytes: (n) => prngBytes(mulberry32(4501), n),
    })();
    await expect(runEnrollment(f.deps, { ...f.params, storeId: otherStore })).rejects.toThrow(
      /only be re-enrolled into that store/,
    );
    expect(f.transport.calls).toHaveLength(calls);
  });

  it('names the replaced registration only when asked to', async () => {
    const { f, oldDeviceId } = await enrolledWithBacklog(46);
    fx = f;
    await runEnrollment(f.deps, { ...f.params, replacesDeviceId: oldDeviceId });
    expect(f.transport.calls.at(-1)!.body.replacesDeviceId).toBe(oldDeviceId);
    expect(f.transport.calls[0]!.body).not.toHaveProperty('replacesDeviceId');
  });
});
