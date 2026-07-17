// Shared L2 harness for the auth-client suite (testing-guide §2.1 L2, T-6, T-7).
//
// EVERYTHING REAL EXCEPT THE I/O boundary: a real better-sqlite3 client DB behind the real op-sqlite
// shim dialect + real client migrations; the REAL command runtime (task 10) with the REAL permission
// evaluator (task 09) reading the REAL directory tables this suite populates via `applyBundle`; real
// noble crypto; the real append/chain/sign path. Faked only at the ports: FakeClock, a seeded PRNG
// id source, an in-memory KeyStore, and — where a suite exercises the LOCKOUT logic rather than
// argon2id itself — a fast, deterministic, input-sensitive KDF wrapped in an invocation spy (the KDF
// as a port is a T-7 boundary; SEC-AUTH-01 proves the real argon2id params separately).
//
// Auth code is imported from `../../src/index.js` (SRC, not dist) so the suite exercises this
// worktree's source, never a stale `@bolusi/core` build (T-14c).
import { CamelCasePlugin, Kysely } from 'kysely';

import {
  createClientDialect,
  createClientOpStore,
  runClientMigrations,
  type ClientDatabase,
  type DbDriver,
} from '@bolusi/db-client';
import { mulberry32, noblePort, randomBytes as prngBytes, type Prng } from '@bolusi/test-support';

import {
  applyBundle,
  assemblePermissionRegistry,
  authOperationRegistry,
  buildPinVerifier,
  CommandRuntime,
  createUuidV7Generator,
  DEFAULT_KDF_PARAMS,
  FLOOR_KDF_PARAMS,
  PermissionEvaluator,
  createDirectorySource,
  type BundleRole,
  type BundleUser,
  type CanonicalRef,
  type ClockPort,
  type CryptoPort,
  type DeviceBundle,
  type KdfParams,
  type KeyStorePort,
  type OpAppendStore,
  type PinVerifier,
  type SigningKeyPort,
} from '../../src/index.js';
import { MAIN_OWNER_IDS, STAFF_IDS, STORE_OWNER_IDS, V0_MODULES } from '../authz/_fixtures.js';
import { openMemoryDriver } from '../projection/better-sqlite3-driver.js';
import { makeFakeClock, type FakeClock } from '../oplog/_fixtures.js';

export { makeFakeClock, type FakeClock };
export { noblePort, DEFAULT_KDF_PARAMS, FLOOR_KDF_PARAMS };

/** Open a fresh, empty client DB behind the real dialect + migrations (no bundle, no genesis). */
export async function openFreshClientDb(): Promise<{
  driver: DbDriver;
  db: Kysely<ClientDatabase>;
}> {
  const driver = openMemoryDriver();
  await runClientMigrations(driver, { now: () => 1 });
  const db = new Kysely<ClientDatabase>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });
  return { driver, db };
}

/**
 * The op store over the REAL driver — one transaction per command, shared with the projection seam.
 *
 * DELEGATES to the PRODUCTION `createClientOpStore` (@bolusi/db-client) — CLAUDE.md §2.8. This used
 * to be a ~60-line `SqliteOpStore` copy of the shipping store; promoting the real one here means the
 * whole auth suite (genesis, chaining, tamper, atomicity) now exercises production code, not a
 * parallel fixture that could silently drift from it.
 */
export function createSqliteOpStore(driver: DbDriver, db: Kysely<ClientDatabase>): OpAppendStore {
  return createClientOpStore({ db, driver });
}

/** In-memory `KeyStorePort` (SecureStore fake). Caches the seed for the sync signing seam. */
export class FakeKeyStore implements KeyStorePort {
  #privateKey: Uint8Array | null = null;
  #token: string | null = null;
  readonly writes: string[] = [];

  persistDevicePrivateKey(seed: Uint8Array): Promise<void> {
    this.#privateKey = Uint8Array.from(seed);
    this.writes.push('device_private_key');
    return Promise.resolve();
  }
  persistDeviceToken(token: string): Promise<void> {
    this.#token = token;
    this.writes.push('device_token');
    return Promise.resolve();
  }
  loadDeviceToken(): Promise<string | null> {
    return Promise.resolve(this.#token);
  }
  loadSigningKey(): Promise<Uint8Array | null> {
    return Promise.resolve(this.#privateKey);
  }
  getSigningKey(): Uint8Array {
    if (this.#privateKey === null) throw new Error('no device private key — unenrolled');
    return this.#privateKey;
  }
  wipe(): Promise<void> {
    this.#privateKey = null;
    this.#token = null;
    this.writes.push('wipe');
    return Promise.resolve();
  }
  get hasPrivateKey(): boolean {
    return this.#privateKey !== null;
  }
  get token(): string | null {
    return this.#token;
  }
}

/**
 * A fast, deterministic, input-sensitive KDF over noble's sha256 — for suites testing the lockout
 * LOGIC, not argon2id. Different PIN or salt ⇒ different output, so wrong-PIN mismatch and
 * correct-PIN match are faithful; the cryptographic strength is argon2id's job (SEC-AUTH-01).
 */
export function makeFastCrypto(base: CryptoPort = noblePort): CryptoPort {
  return {
    ...base,
    kdf: (password, salt, params) => {
      const material = new Uint8Array(password.length + salt.length);
      material.set(password, 0);
      material.set(salt, password.length);
      const digest = base.sha256(material); // 32 bytes
      return Promise.resolve(digest.slice(0, params.outputLength));
    },
  };
}

/** Wrap a CryptoPort so `kdf` invocations are counted (SEC-AUTH-02 / CHAOS-11 KDF-invocation spy). */
export function spyKdf(base: CryptoPort): { crypto: CryptoPort; calls: () => number } {
  let calls = 0;
  return {
    crypto: {
      ...base,
      kdf: (password, salt, params) => {
        calls += 1;
        return base.kdf(password, salt, params);
      },
    },
    calls: () => calls,
  };
}

export interface HarnessOptions {
  /** Override the crypto port (e.g. a fast/spy KDF). Defaults to real noble. */
  readonly crypto?: CryptoPort;
  /** Bundle `idleLockSeconds` (default 300). */
  readonly idleLockSeconds?: number;
  /** Give a role's user a verifier for `pin` (default: nobody — first-PIN territory). */
  readonly verifiers?: {
    readonly owner?: string;
    readonly storeOwner?: string;
    readonly staff?: string;
  };
}

export interface AuthHarness {
  readonly db: Kysely<ClientDatabase>;
  readonly driver: DbDriver;
  readonly runtime: CommandRuntime;
  readonly clock: FakeClock;
  readonly crypto: CryptoPort;
  readonly idSource: () => string;
  readonly evaluator: PermissionEvaluator;
  readonly keystore: FakeKeyStore;
  readonly tenantId: string;
  readonly storeId: string;
  readonly deviceId: string;
  readonly ownerId: string;
  readonly storeOwnerId: string;
  readonly staffId: string;
  readonly otherStoreUserId: string;
  readonly mainOwnerRoleId: string;
  readonly bundle: DeviceBundle;
  /** Ops handed to the projection seam, in apply order. */
  readonly projected: { readonly type: string }[];
  /** Read every op row from the real log, ascending by (deviceId, seq). */
  ops(): Promise<
    {
      type: string;
      userId: string;
      entityId: string;
      seq: number;
      payload: string;
      source: string;
      previousHash: string;
      hash: string;
    }[]
  >;
  buildVerifier(
    pin: string,
    params: KdfParams,
    salt: Uint8Array,
    asOf: CanonicalRef,
  ): Promise<PinVerifier>;
  close(): Promise<void>;
}

const START_MS = 1_726_000_000_000;

/**
 * Open a fully-wired auth harness at a seed. Populates the directory from a bundle (main owner,
 * store owner, staff, plus a foreign-store user), primes the evaluator, and appends the device
 * genesis so later ops are seq ≥ 2.
 */
export async function openAuthHarness(
  seed: number,
  options: HarnessOptions = {},
): Promise<AuthHarness> {
  const driver = openMemoryDriver();
  await runClientMigrations(driver, { now: () => 1 });
  const db = new Kysely<ClientDatabase>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });

  const prng: Prng = mulberry32(seed);
  const clock = makeFakeClock(START_MS);
  const crypto = options.crypto ?? noblePort;

  const identityGen = createUuidV7Generator({
    now: () => START_MS,
    randomBytes: (n) => prngBytes(prng, n),
  });
  const tenantId = identityGen();
  const storeId = identityGen();
  const otherStoreId = identityGen();
  const ownerId = identityGen();
  const storeOwnerId = identityGen();
  const staffId = identityGen();
  const otherStoreUserId = identityGen();
  const deviceId = identityGen();
  const mainOwnerRoleId = identityGen();
  const storeOwnerRoleId = identityGen();
  const staffRoleId = identityGen();

  const keypair = noblePort.ed25519Keygen(prngBytes(prng, 32));
  const idSource = createUuidV7Generator({
    now: () => clock.now(),
    randomBytes: (n) => prngBytes(prng, n),
  });

  const roles: BundleRole[] = [
    {
      id: mainOwnerRoleId,
      name: 'main_owner',
      scopeType: 'tenant',
      isSystemDefault: true,
      permissionIds: MAIN_OWNER_IDS,
    },
    {
      id: storeOwnerRoleId,
      name: 'store_owner',
      scopeType: 'store',
      isSystemDefault: true,
      permissionIds: STORE_OWNER_IDS,
    },
    {
      id: staffRoleId,
      name: 'staff',
      scopeType: 'store',
      isSystemDefault: true,
      permissionIds: STAFF_IDS,
    },
  ];

  const verifierFor = async (pin: string | undefined): Promise<PinVerifier | null> => {
    if (pin === undefined) return null;
    const salt = crypto.randomBytes(16);
    return buildPinVerifier(crypto, encode(pin), FLOOR_KDF_PARAMS, salt, {
      timestamp: START_MS,
      deviceId: '00000000-0000-0000-0000-000000000000',
      seq: 0,
    });
  };

  const users: BundleUser[] = [
    {
      id: ownerId,
      name: 'Ocep',
      photoMediaId: null,
      status: 'active',
      grants: [{ roleId: mainOwnerRoleId, storeId: null }],
      pinVerifier: await verifierFor(options.verifiers?.owner),
    },
    {
      id: storeOwnerId,
      name: 'Sari',
      photoMediaId: null,
      status: 'active',
      grants: [{ roleId: storeOwnerRoleId, storeId }],
      pinVerifier: await verifierFor(options.verifiers?.storeOwner),
    },
    {
      id: staffId,
      name: 'Budi',
      photoMediaId: null,
      status: 'active',
      grants: [{ roleId: staffRoleId, storeId }],
      pinVerifier: await verifierFor(options.verifiers?.staff),
    },
  ];

  const bundle: DeviceBundle = {
    tenant: { id: tenantId, name: 'Bolusi Papua' },
    store: { id: storeId, name: 'Toko Jayapura' },
    settings: { idleLockSeconds: options.idleLockSeconds ?? 300 },
    users,
    rolesSnapshot: roles,
    permissionsSnapshot: [],
  };

  await applyBundle(db, bundle);

  const evaluator = new PermissionEvaluator(
    assemblePermissionRegistry(V0_MODULES),
    createDirectorySource(db),
  );
  await evaluator.prime();

  const projected: { type: string }[] = [];
  const clockPort: ClockPort = { now: () => clock.now() };
  const signingKey: SigningKeyPort = { getSigningKey: () => keypair.secretKey };

  const runtime = new CommandRuntime({
    device: { tenantId, storeId, deviceId },
    evaluator,
    operations: authOperationRegistry,
    store: createClientOpStore({ db, driver }),
    crypto,
    clock: clockPort,
    idSource,
    location: { getBestFix: () => null },
    signingKey,
    queryExecutor: { execute: () => Promise.resolve(undefined as never) },
    applyProjection: (op) => {
      projected.push({ type: op.type });
    },
    syncScheduler: { schedule: () => undefined },
  });

  // Genesis (05 §9.5) so later commands are not the chain's first.
  await runtime.emitRuntimeOp({
    type: 'auth.device_enrolled',
    entityType: 'device',
    entityId: deviceId,
    payload: { storeId, deviceName: 'Kasir 1', devicePublicKeyB64: '' },
    userId: ownerId,
    source: 'system',
  });
  projected.length = 0;

  const _otherStoreId = otherStoreId; // reserved for minimization assertions
  void _otherStoreId;

  return {
    db,
    driver,
    runtime,
    clock,
    crypto,
    idSource,
    evaluator,
    keystore: new FakeKeyStore(),
    tenantId,
    storeId,
    deviceId,
    ownerId,
    storeOwnerId,
    staffId,
    otherStoreUserId,
    mainOwnerRoleId,
    bundle,
    projected,
    ops: async () => {
      const rows = await db
        .selectFrom('operations')
        .select(['type', 'userId', 'entityId', 'seq', 'payload', 'source', 'previousHash', 'hash'])
        .orderBy('deviceId')
        .orderBy('seq')
        .execute();
      return rows.map((r) => ({
        type: r.type,
        userId: r.userId,
        entityId: r.entityId,
        seq: r.seq,
        payload: r.payload,
        source: r.source,
        previousHash: r.previousHash,
        hash: r.hash,
      }));
    },
    buildVerifier: (pin, params, salt, asOf) =>
      buildPinVerifier(crypto, encode(pin), params, salt, asOf),
    close: async () => {
      await db.destroy();
      await driver.close();
    },
  };
}

/** Encode a PIN string to bytes (utf8). */
export function encode(pin: string): Uint8Array {
  const out = new Uint8Array(pin.length);
  for (let i = 0; i < pin.length; i += 1) out[i] = pin.charCodeAt(i);
  return out;
}
