// The PIN-auth fixture (CHAOS-11, testing-guide §3.6): it WIRES the PRODUCTION offline-PIN verify +
// lockout machine + recovery flows over a real client DB — the harness owns no auth logic (T-7).
//
// EVERYTHING REAL EXCEPT THE KDF: a real better-sqlite3 client DB behind the shim + the real client
// migrations, the real `CommandRuntime` (task 10) over the real `authOperationRegistry`, the real
// `verifyPin`/`clearPinLockoutFlow`/`resetPin`/`createLockedOutEmitter` (pin-verify.ts/pin-flows.ts),
// the real `PIN_LOCKOUT_SCHEDULE`/`delayMsForFailureCount` (constants.ts). The ONLY fake is a fast,
// deterministic, input-sensitive `kdf` wrapped in an invocation spy — the KDF is a port boundary
// (SEC-AUTH-01 proves argon2id's real params separately), and CHAOS-11's subject is the SCHEDULE and
// the "no KDF runs during a window/lock" property, so the spy IS the budget/oracle meter.
import { CamelCasePlugin, Kysely, sql } from 'kysely';

import {
  authModuleManifest,
  authOperationRegistry,
  buildPinVerifier,
  bytesToBase64,
  CommandRuntime,
  createLockedOutEmitter,
  createUuidV7Generator,
  DEFAULT_KDF_PARAMS,
  PinVerifierQueue,
  writeVerifier,
  type ClockPort,
  type CryptoPort,
  type LocationPort,
  type PinFlowDeps,
  type SigningKeyPort,
  type SyncSchedulerPort,
} from '@bolusi/core';
import {
  createClientDialect,
  createClientOpStore,
  runClientMigrations,
  type ClientDatabase,
  type DbDriver,
} from '@bolusi/db-client';
import {
  deriveDeviceKeypair,
  FakeClock,
  mulberry32,
  noblePort,
  randomBytes,
  type Prng,
} from '@bolusi/test-support';

import { openMemoryDriver } from './driver.js';
import { buildGrantAllEvaluator } from './permissions.js';

const CLOCK_BASE = 1_726_100_000_000;

/**
 * A fast, deterministic, input-sensitive KDF over noble's sha256 (for the lockout LOGIC, not
 * argon2id), wrapped in a call spy. Different PIN or salt ⇒ different output, so a wrong-PIN mismatch
 * and a correct-PIN match are faithful. `calls()` is the KDF-invocation meter (§3.6): the KDF runs
 * iff the gate let the attempt through, so a flat count proves "no KDF during a window/lock".
 */
export function spyFastKdf(base: CryptoPort = noblePort): {
  crypto: CryptoPort;
  calls: () => number;
} {
  let calls = 0;
  return {
    crypto: {
      ...base,
      kdf: (password, salt, params) => {
        calls += 1;
        const material = new Uint8Array(password.length + salt.length);
        material.set(password, 0);
        material.set(salt, password.length);
        return Promise.resolve(base.sha256(material).slice(0, params.outputLength));
      },
    },
    calls: () => calls,
  };
}

/** One op row from the local log, for asserting the `auth.pin_locked_out` / `_cleared` evidence. */
export interface AuthOpRow {
  readonly type: string;
  readonly userId: string;
  readonly source: string;
  readonly payload: string;
}

export interface PinFixture {
  readonly db: Kysely<ClientDatabase>;
  readonly driver: DbDriver;
  readonly clock: FakeClock;
  readonly crypto: CryptoPort;
  readonly runtime: CommandRuntime;
  readonly deviceId: string;
  /** The locked-out target (has a verifier + attempt state). */
  readonly staffId: string;
  /** The recovery actor (granted `auth.pin_unlock` / `auth.user_reset_pin`). */
  readonly ownerId: string;
  /** The KDF-invocation count so far (§3.6 spy). */
  kdfCalls(): number;
  /** The `PinFlowDeps` a recovery flow (`clearPinLockoutFlow`/`resetPin`) consumes. */
  flowDeps(): PinFlowDeps<ClientDatabase>;
  /** Every auth op appended locally, in (deviceId, seq) order. */
  authOps(): Promise<AuthOpRow[]>;
  close(): Promise<void>;
}

/**
 * Open a PIN fixture at `seed`: staff has a known `pin` (a verifier written at DEFAULT params); the
 * owner is granted the recovery permissions; both are in the directory so a reset/unlock passes the
 * §5.4.6 targeting check. The clock is a FakeClock — the ONLY time source (T-6).
 */
export async function openPinFixture(
  seed: number,
  options: { readonly pin: string },
): Promise<PinFixture> {
  const driver = openMemoryDriver();
  await runClientMigrations(driver, { now: () => 1 });
  const db = new Kysely<ClientDatabase>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });

  const prng: Prng = mulberry32(seed);
  const clock = new FakeClock(CLOCK_BASE);
  const idClock = new FakeClock(CLOCK_BASE);
  const ids = createUuidV7Generator({
    now: () => idClock.now(),
    randomBytes: (n) => randomBytes(prng, n),
  });
  const tenantId = ids();
  const storeId = ids();
  const ownerId = ids();
  const staffId = ids();
  const deviceId = ids();

  const spy = spyFastKdf();
  const crypto = spy.crypto;

  // Directory rows so the recovery flows' §5.4.6 targeting check (`userInDirectory`) passes. Staff
  // holds no tenant-scoped system-default role, so `holdsMainOwnerRole(staff)` is false and a reset
  // never trips the §6.6 privileged-target rule.
  for (const [id, name] of [
    [ownerId, 'owner'],
    [staffId, 'staff'],
  ] as const) {
    await sql`INSERT INTO users_directory (id, name, photo_media_id, status)
              VALUES (${id}, ${name}, ${null}, ${'active'})`.execute(db);
  }

  // Grant the recovery ACTOR (owner) every auth permission via the REAL evaluator over the REAL auth
  // manifest (§2.8 — the ids come from the manifest, not a hand-typed list). verifyPin checks no
  // permission; only the recovery commands do, and they run as the owner.
  const evaluator = await buildGrantAllEvaluator({
    tenantId,
    userId: ownerId,
    manifests: [authModuleManifest],
  });

  const keypair = deriveDeviceKeypair(seed, 0);
  const clockPort: ClockPort = { now: () => clock.now() };
  const signingKey: SigningKeyPort = { getSigningKey: () => keypair.seed };
  const location: LocationPort = { getBestFix: () => null };
  const syncScheduler: SyncSchedulerPort = { schedule: () => undefined };
  const idSource = createUuidV7Generator({
    now: () => clock.now(),
    randomBytes: (n) => randomBytes(prng, n),
  });

  const runtime = new CommandRuntime({
    device: { tenantId, storeId, deviceId },
    evaluator,
    operations: authOperationRegistry,
    store: createClientOpStore({ db, driver }),
    crypto,
    clock: clockPort,
    idSource,
    location,
    signingKey,
    queryExecutor: { execute: () => Promise.resolve(undefined as never) },
    applyProjection: () => Promise.resolve(),
    syncScheduler,
  });

  // Genesis (05 §9.5) so later runtime emissions are not the chain's first op.
  await runtime.emitRuntimeOp({
    type: 'auth.device_enrolled',
    entityType: 'device',
    entityId: deviceId,
    payload: {
      storeId,
      deviceName: 'device',
      devicePublicKeyB64: bytesToBase64(keypair.publicKey),
    },
    userId: ownerId,
    source: 'system',
  });

  // Staff's verifier — built at the emitted genesis position's `asOf` shape, at DEFAULT params.
  const salt = crypto.randomBytes(16);
  const verifier = await buildPinVerifier(
    crypto,
    encodePin(options.pin),
    DEFAULT_KDF_PARAMS,
    salt,
    {
      timestamp: CLOCK_BASE,
      deviceId,
      seq: 1,
    },
  );
  await writeVerifier(db, staffId, verifier);

  const emitter = createLockedOutEmitter(runtime);

  // Baseline the KDF spy AFTER setup (building the verifier ran the KDF once) so `kdfCalls()` counts
  // only the attempts a scenario drives — the schedule meter starts at 0 (mirrors the core harness).
  const baseline = spy.calls();

  return {
    db,
    driver,
    clock,
    crypto,
    runtime,
    deviceId,
    staffId,
    ownerId,
    kdfCalls: () => spy.calls() - baseline,
    flowDeps: () => ({
      runtime,
      db,
      crypto,
      clock: clockPort,
      idSource,
      deviceId,
      queue: new PinVerifierQueue(),
      emitter,
    }),
    authOps: async () => {
      const rows = await db
        .selectFrom('operations')
        .select(['type', 'userId', 'source', 'payload'])
        .orderBy('deviceId')
        .orderBy('seq')
        .execute();
      return rows as AuthOpRow[];
    },
    close: async () => {
      await db.destroy();
      await driver.close();
    },
  };
}

/** The emitter the verify path uses — exported so a scenario can rebuild `PinVerifyDeps`. */
export function verifyDeps(fixture: PinFixture): {
  db: Kysely<ClientDatabase>;
  crypto: CryptoPort;
  clock: ClockPort;
  deviceId: string;
  emitter: ReturnType<typeof createLockedOutEmitter>;
} {
  const emitter = createLockedOutEmitter(fixture.runtime);
  return {
    db: fixture.db,
    crypto: fixture.crypto,
    clock: { now: () => fixture.clock.now() },
    deviceId: fixture.deviceId,
    emitter,
  };
}

/** Encode a PIN string to UTF-8 bytes. */
export function encodePin(pin: string): Uint8Array {
  const out = new Uint8Array(pin.length);
  for (let i = 0; i < pin.length; i += 1) out[i] = pin.charCodeAt(i);
  return out;
}
