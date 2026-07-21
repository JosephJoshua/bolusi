/**
 * Fixture for the composed-app test (task 119) — boots the REAL data layer, seeds a REAL enrolled
 * device with a REAL directory and a REAL argon2id PIN verifier, and mounts the REAL `Root`.
 *
 * Lives under `test/` because it imports better-sqlite3 (test-only, 08 §2.5) and the render harness.
 * It builds no auth logic and no runtime of its own: it seeds ROWS through core's own writers
 * (`replaceUsersDirectory`, `writeVerifier`, `writeMeta`) and appends the genesis through the REAL
 * command runtime, so what the app reads back at boot is what production would have written.
 */
import {
  buildPinVerifier,
  createUuidV7Generator,
  replaceRolesDirectory,
  replaceUsersDirectory,
  replaceUserRolesDirectory,
  readPinAttempt,
  writeMeta,
  writeVerifier,
  DEVICE_ID_META_KEY,
  STORE_ID_META_KEY,
  type PermissionEvaluator,
} from '@bolusi/core';
import { closeClientDb } from '@bolusi/db-client';
import { mulberry32, noblePort, randomBytes as prngBytes } from '@bolusi/test-support';
import type { SignedOperation } from '@bolusi/schemas';
import { act } from 'react';

import { bootstrap, type Bootstrapped } from '../src/bootstrap/bootstrap.js';
import { createAppRuntime, type AppRuntime } from '../src/bootstrap/runtime.js';
import { createSessionNotesRuntime, UNWIRED_NOTES_MEDIA } from '../src/bootstrap/notes.js';
import { createAppSession } from '../src/bootstrap/session.js';
import { Root } from '../src/bootstrap/Root.js';
import type { AppEnrollment } from '../src/bootstrap/enrollment.js';
import { openBetterSqlite3Driver } from './better-sqlite3-driver.js';
import { render, fire, type RenderResult } from '../../../packages/ui/test/render.js';
import { ensureNotesCatalog } from './notes-support.js';

export { closeClientDb, buildPinVerifier };
export type { Bootstrapped };

/** The PIN the seeded verifier is built from. Six digits (api/02-auth §6.1). */
export const TEST_PIN = '482913';

/** The note a *foreign device* created, delivered through the pull path. */
export const NOTE_FROM_ANOTHER_DEVICE = '01920000-0000-7000-8000-0000000119a1';

const FIXED_NOW = 1_726_000_000_000;
const ROLE_ID = 'role-notes-live';

/** A CSPRNG stand-in that never repeats (bootstrap.test.ts's own rule — T-13). */
let nonce = 0;
const fakeCrypto = {
  ...noblePort,
  randomBytes: (length: number) => {
    nonce += 1;
    return Uint8Array.from({ length }, (_, i) => (i * 7 + nonce * 31 + 3) & 0xff);
  },
};

export interface Fixture {
  /** The booted app. REPLACED by `mountRoot`'s re-boot — read it after mounting, never before. */
  app: Bootstrapped;
  readonly location: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly deviceId: string;
  readonly userId: string;
  close(): Promise<void>;
}

function bootAt(location: string): Promise<Bootstrapped> {
  return bootstrap({
    driverFactory: openBetterSqlite3Driver,
    keyStore: {
      ensureDatabaseEncryptionKey: () => Promise.resolve('a'.repeat(64)),
      getDatabaseEncryptionKey: () => Promise.resolve('a'.repeat(64)),
    } as unknown as Parameters<typeof bootstrap>[0]['keyStore'],
    crypto: fakeCrypto as unknown as Parameters<typeof bootstrap>[0]['crypto'],
    clock: { now: () => FIXED_NOW },
    databaseLocation: location,
  });
}

/**
 * ONE id stream and ONE device key for the whole fixture, module-scoped on purpose.
 *
 * `runtimeFor` is called TWICE per test — once to append the genesis, once after the re-boot — and a
 * per-call PRNG would restart both streams. The second runtime would then mint the SAME op ids the
 * genesis already used, so the first session op would collide on the `operations` primary key and
 * the unlock would fail for a reason that has nothing to do with the code under test. A real device
 * has one monotonic id source and one persistent signing key across restarts; this mirrors that.
 */
const idPrng = mulberry32(119);
const DEVICE_KEYPAIR = noblePort.ed25519Keygen(new Uint8Array(32).fill(9));
let opClock = FIXED_NOW;

/** Build the app runtime over a booted app, with every port a Node-safe real implementation. */
export function runtimeFor(app: Bootstrapped): AppRuntime {
  return createAppRuntime(app, {
    crypto: noblePort,
    clock: { now: () => (opClock += 1) },
    idSource: createUuidV7Generator({
      now: () => opClock,
      randomBytes: (n) => prngBytes(idPrng, n),
    }),
    location: { getBestFix: () => null },
    signingKey: { getSigningKey: () => DEVICE_KEYPAIR.secretKey },
    syncScheduler: { schedule: () => undefined },
  });
}

/** Boot a fresh app over a FILE database (so the seed survives the re-boot `mountRoot` performs). */
export async function bootFixture(): Promise<Fixture> {
  const location = `${process.env['TMPDIR'] ?? '/tmp'}/bolusi-live-shell-${String(Date.now())}-${String(
    Math.floor(Math.random() * 1e6),
  )}.db`;
  const app = await bootAt(location);
  const fixture: Fixture = {
    app,
    location,
    tenantId: '01920000-0000-7000-8000-0000000119a0',
    storeId: '01920000-0000-7000-8000-0000000119b0',
    deviceId: '01920000-0000-7000-8000-0000000119c0',
    userId: '01920000-0000-7000-8000-0000000119d0',
    close: async () => {
      await closeClientDb();
    },
  };
  return fixture;
}

/**
 * Make the device ENROLLED, the way enrollment does: persist `deviceId`/`storeId`/tenant to
 * `meta_kv` (task 88) and append the genesis `auth.device_enrolled` op through the REAL command
 * runtime (05 §9.5 — a device cannot command before its chain starts).
 */
export async function enrolledDevice(fixture: Fixture): Promise<void> {
  const db = fixture.app.db.db;
  await writeMeta(db, DEVICE_ID_META_KEY, fixture.deviceId);
  await writeMeta(db, STORE_ID_META_KEY, fixture.storeId);
  await writeMeta(db, 'tenantId', fixture.tenantId);

  const commands = runtimeFor(fixture.app).runtimeFor({
    tenantId: fixture.tenantId,
    storeId: fixture.storeId,
    deviceId: fixture.deviceId,
  });
  await commands.emitRuntimeOp({
    type: 'auth.device_enrolled',
    entityType: 'device',
    entityId: fixture.deviceId,
    payload: { enrolledDeviceId: fixture.deviceId },
    userId: fixture.userId,
  });
}

/**
 * Seed the directory mirror + the PIN verifier — the state a bundle refresh leaves behind
 * (api/02-auth §5.2/§5.3). The verifier is a REAL argon2id derivation of `TEST_PIN`, so `verifyPin`
 * genuinely has to match it; a wrong PIN genuinely fails.
 */
export async function seedDirectory(fixture: Fixture): Promise<void> {
  const db = fixture.app.db.db;
  await replaceUsersDirectory(db, [
    { id: fixture.userId, name: 'Andi Pratama', photoMediaId: null, status: 'active' },
  ]);
  await replaceRolesDirectory(db, [
    {
      id: ROLE_ID,
      name: 'Notes',
      scopeType: 'store',
      isSystemDefault: false,
      permissionIds: ['notes.read', 'notes.create', 'notes.edit', 'notes.archive'],
    },
  ]);
  await replaceUserRolesDirectory(db, [
    { userId: fixture.userId, roleId: ROLE_ID, storeId: fixture.storeId },
  ]);

  const verifier = await buildPinVerifier(
    noblePort,
    new TextEncoder().encode(TEST_PIN),
    // The §5.3 FLOOR, not a convenient shortcut: `assertVerifierInBounds` rejects anything cheaper,
    // and `verifyPin` re-derives with these same stored params — so the KDF this test runs is the one
    // a device runs. `outputLength` 32 is the bounds' required hash size.
    { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLength: 32 },
    Uint8Array.from({ length: 16 }, (_, i) => i + 1),
    { timestamp: FIXED_NOW, deviceId: fixture.deviceId, seq: 1 },
  );
  await writeVerifier(db, fixture.userId, verifier);
}

/**
 * Re-boot (so `deviceId` is READ from the seeded `meta_kv`, exactly as a real restart would) and
 * mount the LIVE `Root` with the production factories.
 *
 * `createEnrollment` returns a real `AppEnrollment` around a real `AppRuntime`; its transports are
 * never called because the device is already enrolled. `createSession` and `createNotes` are the
 * PRODUCTION functions — this test exercises the same code `index.ts` wires.
 */
export async function mountRoot(fixture: Fixture): Promise<RenderResult> {
  ensureNotesCatalog();
  await closeClientDb();
  fixture.app = await bootAt(fixture.location);
  const app = fixture.app;
  const runtime = runtimeFor(app);

  const enrollment: AppEnrollment = {
    controller: {
      login: () => Promise.reject(new Error('login not used by this test')),
      enroll: () => Promise.reject(new Error('enroll not used by this test')),
    },
    evaluator: runtime.evaluator as PermissionEvaluator,
    runtime,
  };

  const screen = render(
    <Root
      localeStore={{ read: () => Promise.resolve(null), write: () => Promise.resolve() }}
      readDeviceInfo={() =>
        Promise.resolve({
          deviceId: app.deviceId ?? '',
          deviceName: 'Konter Depan',
          storeName: 'Servis Ponsel Maju',
          tenantName: 'Maju Group',
          platform: 'android',
          appVersion: '0.0.0-test',
        })
      }
      boot={() => Promise.resolve(app)}
      createEnrollment={() => enrollment}
      createSession={(booted, appRuntime) =>
        createAppSession({
          app: booted,
          runtime: appRuntime,
          crypto: noblePort,
          clock: { now: () => FIXED_NOW },
          idSource: createUuidV7Generator({
            now: () => FIXED_NOW,
            randomBytes: (n) => prngBytes(mulberry32(7), n),
          }),
        })
      }
      createNotes={(booted, appRuntime, identity) =>
        createSessionNotesRuntime({
          app: booted,
          runtime: appRuntime,
          identity,
          media: UNWIRED_NOTES_MEDIA,
        })
      }
    />,
  );
  await settle();
  return screen;
}

/** Flush the microtask queue inside `act` so effects and queries settle before an assertion. */
export async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
}

/** Press a node by testID and let the tree settle. */
export function fireOn(screen: RenderResult, testID: string): void {
  fire(screen.get(testID), 'onPress');
}

/**
 * Tap the six digits on the REAL keypad — the pad buffers them and fires `onComplete` itself.
 *
 * Then WAIT ON A CONDITION rather than on a fixed number of microtask flushes. `verifyPin` runs
 * argon2id at the §5.3 floor (19 MiB, t=2), which is hundreds of milliseconds of genuine async work;
 * a microtask drain returns long before it finishes and would leave every assertion below reading a
 * tree that had not caught up. A fixed `setTimeout` would be worse — it would pass on this machine
 * and flake on a loaded CI runner (this repo's own starvation analysis, apps/mobile/vitest.config.ts).
 */
export async function submitPin(screen: RenderResult, pin: string): Promise<boolean> {
  for (const digit of pin) fire(screen.get(`pin-pad.key.${digit}`), 'onPress');
  // Settles when the gate has MOVED OFF the pad — i.e. a session opened. Returns whether it did, so
  // the wrong-PIN control asserts on the same signal the happy path does.
  const opened = await waitUntil(() => screen.query('pin-pad') === null);
  await settle();
  return opened;
}

/**
 * Wait until the REAL `pin_attempt_state` row records a failure — proof that `verifyPin` actually
 * ran and rejected, rather than proof that the test got bored.
 *
 * This is what makes the wrong-PIN control rigorous. Asserting "the pad is still showing" after a
 * fixed sleep would also pass if the submit handler had never been wired at all — the exact
 * pre-task-119 state (`onSubmitPin: () => undefined`). The counter moving is the witness that the
 * verify path was entered and refused.
 */
export async function waitForFailedAttempt(fixture: Fixture): Promise<number> {
  let failures = 0;
  await waitUntil(async () => {
    const row = await readPinAttempt(fixture.app.db.db, fixture.userId, fixture.deviceId);
    failures = row?.consecutiveFailures ?? 0;
    return failures > 0;
  });
  return failures;
}

/**
 * Poll `predicate` on real timers inside `act`, up to `timeoutMs`. Returns whether it became true —
 * never throws, so a caller asserting the NEGATIVE case (a wrong PIN must NOT open a session) waits
 * the full budget and then asserts, rather than being handed a pass by a helper that gave up early.
 */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

/** A foreign-device `notes.note_created` op, scoped to this fixture's tenant + store. */
export function pulledNote(fixture: Fixture): SignedOperation {
  return {
    id: 'op-remote-119a1',
    tenantId: fixture.tenantId,
    storeId: fixture.storeId,
    userId: '01920000-0000-7000-8000-0000000119e0',
    deviceId: '01920000-0000-7000-8000-0000000119f0',
    seq: 1,
    type: 'notes.note_created',
    entityType: 'note',
    entityId: NOTE_FROM_ANOTHER_DEVICE,
    // DELIBERATELY LEFT AT v2 (task 120). The current emitted version is 3, so this fixture is no
    // longer "the shape a new op has" — it is now a BACKWARD-COMPATIBILITY regression test, and a
    // more valuable one than a v3 copy would be. 05 §7 says historical payloads never disappear, so
    // the applier must fold v1/v2/v3 forever; this is the composed-app proof that a v2 op pulled
    // from another device still lands in the projection and still reaches the mounted list. Bumping
    // it to v3 would delete that coverage and leave nothing exercising the old fold end to end.
    schemaVersion: 2,
    payload: { title: 'Dari HP lain', body: 'pulled', mediaId: null },
    timestamp: FIXED_NOW,
    location: null,
    source: 'ui',
    agentInitiated: false,
    agentConversationId: null,
    previousHash: '0'.repeat(64),
    hash: '1'.repeat(64),
    signature: 'remote-sig',
  } as SignedOperation;
}
