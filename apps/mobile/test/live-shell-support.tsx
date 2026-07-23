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
  applyBundle,
  buildPinVerifier,
  createUuidV7Generator,
  IDLE_LOCK_DEFAULT_SECONDS,
  readPinAttempt,
  writeMeta,
  DEVICE_ID_META_KEY,
  STORE_ID_META_KEY,
  type CancelTimer,
  type ClockPort,
  type DeviceBundle,
  type PermissionEvaluator,
  type TimerPort,
} from '@bolusi/core';
import { closeClientDb } from '@bolusi/db-client';
import {
  mulberry32,
  noblePort,
  randomBytes as prngBytes,
  nodeColumnAead,
} from '@bolusi/test-support';
import type { SignedOperation } from '@bolusi/schemas';
import { act } from 'react';

import { bootstrap, type Bootstrapped } from '../src/bootstrap/bootstrap.js';
import { createAppRuntime, type AppRuntime } from '../src/bootstrap/runtime.js';
import { createSessionNotesRuntime, notesMediaSeamsFor } from '../src/bootstrap/notes.js';
import { createAppSession, type AppSessionController } from '../src/bootstrap/session.js';
import { Root, type RootProps } from '../src/bootstrap/Root.js';
import type { AppEnrollment } from '../src/bootstrap/enrollment.js';
import type { AppStatePort, AppStatus } from '../src/bootstrap/triggers.js';
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
    aead: nodeColumnAead,
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
 * Seed the directory mirror + the PIN verifier THROUGH `applyBundle` — the exact writer a real
 * device's enroll response and every bundle refresh use (api/02-auth §5.2/§5.3).
 *
 * It used to call the four low-level directory writers instead. Going through `applyBundle` is
 * strictly more faithful and it is what lets this fixture carry `settings.idleLockSeconds`: that
 * value only reaches a device because `applyBundle` persists it, so a fixture that wrote the rows by
 * hand could never witness the §6.4 threading (task 133's second defect — `SessionManager` was
 * constructed without it and the tenant's setting stopped at the server).
 *
 * The verifier is a REAL argon2id derivation of `TEST_PIN`, so `verifyPin` genuinely has to match
 * it; a wrong PIN genuinely fails.
 */
export async function seedDirectory(
  fixture: Fixture,
  idleLockSeconds: number = IDLE_LOCK_DEFAULT_SECONDS,
): Promise<void> {
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

  const bundle: DeviceBundle = {
    tenant: { id: fixture.tenantId, name: 'Maju Group' },
    store: { id: fixture.storeId, name: 'Servis Ponsel Maju' },
    settings: { idleLockSeconds },
    users: [
      {
        id: fixture.userId,
        name: 'Andi Pratama',
        photoMediaId: null,
        status: 'active',
        grants: [{ roleId: ROLE_ID, storeId: fixture.storeId }],
        pinVerifier: verifier,
      },
    ],
    rolesSnapshot: [
      {
        id: ROLE_ID,
        name: 'Notes',
        scopeType: 'store',
        isSystemDefault: false,
        permissionIds: ['notes.read', 'notes.create', 'notes.edit', 'notes.archive'],
      },
    ],
    permissionsSnapshot: [],
  };
  await applyBundle(fixture.app.db.db, bundle);
}

/** A SECOND enrolled user on the same device — the incoming user in a switch/lock-unlock test. */
export const SECOND_USER_ID = '01920000-0000-7000-8000-0000000130d1';

/**
 * Seed TWO active users, each with a REAL argon2id verifier of `TEST_PIN` (task 130's Defect-2 test).
 *
 * Both go through `applyBundle` — the exact writer a real enroll response uses — so a switch between
 * them exercises the real directory the switcher reads and the real `verifyPin` for each. Distinct
 * salts + `seq`, so the two verifier rows genuinely differ even though the PIN is the same; a wrong
 * PIN still fails for either.
 */
export async function seedTwoUsers(
  fixture: Fixture,
  idleLockSeconds: number = IDLE_LOCK_DEFAULT_SECONDS,
): Promise<void> {
  const verifierFor = (
    seq: number,
    saltBase: number,
  ): Promise<Awaited<ReturnType<typeof buildPinVerifier>>> =>
    buildPinVerifier(
      noblePort,
      new TextEncoder().encode(TEST_PIN),
      { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLength: 32 },
      Uint8Array.from({ length: 16 }, (_, i) => i + saltBase),
      { timestamp: FIXED_NOW, deviceId: fixture.deviceId, seq },
    );
  const [verifierA, verifierB] = await Promise.all([verifierFor(1, 1), verifierFor(2, 100)]);

  const bundle: DeviceBundle = {
    tenant: { id: fixture.tenantId, name: 'Maju Group' },
    store: { id: fixture.storeId, name: 'Servis Ponsel Maju' },
    settings: { idleLockSeconds },
    users: [
      {
        id: fixture.userId,
        name: 'Andi Pratama',
        photoMediaId: null,
        status: 'active',
        grants: [{ roleId: ROLE_ID, storeId: fixture.storeId }],
        pinVerifier: verifierA,
      },
      {
        id: SECOND_USER_ID,
        name: 'Budi Santoso',
        photoMediaId: null,
        status: 'active',
        grants: [{ roleId: ROLE_ID, storeId: fixture.storeId }],
        pinVerifier: verifierB,
      },
    ],
    rolesSnapshot: [
      {
        id: ROLE_ID,
        name: 'Notes',
        scopeType: 'store',
        isSystemDefault: false,
        permissionIds: ['notes.read', 'notes.create', 'notes.edit', 'notes.archive'],
      },
    ],
    permissionsSnapshot: [],
  };
  await applyBundle(fixture.app.db.db, bundle);
}

/**
 * A FakeClock for the fixture (testing-guide §3.3) — time moves only when a test moves it.
 *
 * `SessionManager` reads its idle deadline from whatever clock this fixture hands `createAppSession`,
 * so this is what makes the §6.4 transition drivable without sleeping (T-6: a test that sleeps is a
 * bug). The default `mountRoot` clock is still the FIXED one, so tests that do not care are unchanged.
 */
export function advanceableClock(start = FIXED_NOW): ClockPort & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

/**
 * A `TimerPort` that fires only when the test says so.
 *
 * Deliberately NOT a real `setTimeout`: the idle ticker re-arms itself, so a real timer would make
 * this suite depend on wall-clock scheduling on a loaded runner — the flake class
 * `apps/mobile/vitest.config.ts` documents at length. `fire()` runs every callback pending AT THE
 * MOMENT OF THE CALL and not the ones they re-arm, so one call is exactly one tick.
 */
export interface ManualTimer extends TimerPort {
  /** Run every currently-pending callback once. Returns how many ran. */
  fire(): number;
  pending(): number;
}

export function manualTimer(): ManualTimer {
  let nextId = 0;
  const scheduled = new Map<number, () => void>();
  return {
    schedule(_delayMs: number, fn: () => void): CancelTimer {
      const id = (nextId += 1);
      scheduled.set(id, fn);
      return () => {
        scheduled.delete(id);
      };
    },
    fire(): number {
      // Snapshot first: every callback re-arms, and iterating the live map would spin forever.
      const due = [...scheduled.entries()];
      for (const [id, fn] of due) {
        scheduled.delete(id);
        fn();
      }
      return due.length;
    },
    pending: () => scheduled.size,
  };
}

/**
 * A `TimerPort` with a VIRTUAL CLOCK — `advance(ms)` fires only what is due by then (task 136).
 *
 * {@link manualTimer} deliberately ignores delays, which is right for the idle ticker (one `fire()`
 * = one tick) and wrong for a DEBOUNCE: a debounce is defined by its window, and a timer that fires
 * everything on demand cannot tell "scheduled 3 s out" from "fired immediately". This one holds a
 * due-time per callback, so a test can assert the sync has NOT run at `APPEND_DEBOUNCE_MS - 1` and
 * HAS at `APPEND_DEBOUNCE_MS` — against the exported constant, never a literal (T-6).
 *
 * Deliberately NOT `vi.useFakeTimers()`: this lane's PIN unlock runs a real argon2id derivation and
 * `waitUntil` polls on real timers, both of which a global fake-timer install would freeze.
 */
export interface VirtualTimer extends TimerPort {
  /** Move virtual time forward and run everything that came due, in due order. */
  advance(ms: number): void;
  pending(): number;
}

export function virtualTimer(): VirtualTimer {
  interface Entry {
    readonly id: number;
    readonly dueAt: number;
    readonly fn: () => void;
  }
  let now = 0;
  let nextId = 0;
  let scheduled: Entry[] = [];
  return {
    schedule(delayMs: number, fn: () => void): CancelTimer {
      const id = (nextId += 1);
      scheduled.push({ id, dueAt: now + delayMs, fn });
      return () => {
        scheduled = scheduled.filter((entry) => entry.id !== id);
      };
    },
    advance(ms: number): void {
      now += ms;
      // Snapshot and remove BEFORE running: the sync triggers re-arm inside their own callback (the
      // 60 s interval does), and iterating the live array would spin forever.
      const due = scheduled.filter((entry) => entry.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt);
      scheduled = scheduled.filter((entry) => entry.dueAt > now);
      for (const entry of due) entry.fn();
    },
    pending: () => scheduled.length,
  };
}

/** An `AppStatePort` the test drives — starts foregrounded, which is what a device in use is. */
export interface FakeAppState extends AppStatePort {
  /** Push a status change to every subscriber (RN's `AppState` change event). */
  set(status: AppStatus): void;
}

export function fakeAppState(initial: AppStatus = 'active'): FakeAppState {
  let status = initial;
  const listeners = new Set<(next: AppStatus) => void>();
  return {
    current: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      status = next;
      for (const listener of listeners) listener(next);
    },
  };
}

/**
 * Re-boot (so `deviceId` is READ from the seeded `meta_kv`, exactly as a real restart would) and
 * mount the LIVE `Root` with the production factories.
 *
 * `createEnrollment` returns a real `AppEnrollment` around a real `AppRuntime`; its transports are
 * never called because the device is already enrolled. `createSession` and `createNotes` are the
 * PRODUCTION functions — this test exercises the same code `index.ts` wires.
 */
export interface MountOptions {
  /**
   * The clock `SessionManager` measures the idle deadline against (api/02-auth §6.4). Defaults to
   * the FIXED one, so every pre-task-133 test behaves exactly as before; an idle-lock test passes an
   * {@link advanceableClock} and moves it.
   */
  readonly clock?: ClockPort;
  /**
   * The idle ticker's `TimerPort`. Defaults to a timer that NEVER fires — a fixture default that
   * fails in the SAFE direction: a test that forgets to drive it sees no lock and reds, rather than
   * a real `setTimeout` leaking past the test and firing over an unmounted tree.
   */
  readonly timer?: TimerPort;
  /** The idle ticker's `AppStatePort`. Defaults to foregrounded. */
  readonly appState?: AppStatePort;
  /**
   * Hand the test the session controller `Root` composed — the PRODUCTION `createAppSession` result,
   * not a substitute, so an assertion on it is an assertion about what the app is running.
   */
  readonly onSessionController?: (controller: AppSessionController) => void;
  /**
   * The push-token registration factory (api/04-push §2; task 135). Omitted by default, so tests that
   * do not exercise push behave exactly as before — `Root` skips registration when it is `undefined`.
   * The push composed test passes a fake that records `postToken` calls.
   */
  readonly createPushRegistration?: RootProps['createPushRegistration'];
  /** The notification-tap seam (api/04-push §4/§6; task 135). Omitted by default (no listener). */
  readonly pushRouter?: RootProps['pushRouter'];
  /**
   * The enrollment factory (api/02-auth §4; task 92). Omitted by default, so the pre-enrolled tests use
   * the rejecting stub below (the device is already enrolled — the transports are never called). The
   * push ENROLLMENT-leg test (task 135) injects a REAL `createAppEnrollment` over fake transports so
   * `onEnrolled` fires through the real composition and Root's push registration runs.
   */
  readonly createEnrollment?: RootProps['createEnrollment'];
  /**
   * The sync-client factory (api/01-sync; task 136). Omitted by default — every pre-136 test mounted
   * with NO `createSync` at all, which is precisely why `Root`'s sync wiring was unobservable and how
   * the step-7 no-op shipped. The scheduler test passes a REAL `createSyncClient` over a fake
   * transport and a {@link virtualTimer}, so the debounce is measured rather than assumed.
   */
  readonly createSync?: RootProps['createSync'];
  /**
   * The media-client factory (06; task 130). Omitted by default — every pre-130 test mounted with NO
   * `createMedia`, which is precisely why `MediaClient.requestManual()` had zero production callers
   * and nothing noticed: the composed lane never had a media client for `Root` to fail to call.
   */
  readonly createMedia?: RootProps['createMedia'];
  /**
   * The in-app camera's native seams (06 §2.1; task 130). Omitted by default, so the notes attach
   * seam stays the REJECTING `UNWIRED_NOTES_MEDIA.capturePhoto` — the honest pre-130 behaviour — and
   * only the capture test opts in with a fake camera.
   */
  readonly capturePlatform?: RootProps['capturePlatform'];
}

export async function mountRoot(
  fixture: Fixture,
  options: MountOptions = {},
): Promise<RenderResult> {
  ensureNotesCatalog();
  await closeClientDb();
  fixture.app = await bootAt(fixture.location);
  const app = fixture.app;
  const runtime = runtimeFor(app);
  const sessionClock: ClockPort = options.clock ?? { now: () => FIXED_NOW };

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
      // Real when the enroll-leg test injects one (task 135), else the rejecting stub (device already
      // enrolled, transports never called) — every pre-enrolled test is unchanged.
      createEnrollment={options.createEnrollment ?? (() => enrollment)}
      // Absent unless a test opts in (task 136), so every other live-shell test mounts exactly as
      // before — no loop, no triggers, no timers left running past the test. Spread rather than
      // passed as `undefined`: `exactOptionalPropertyTypes` distinguishes the two.
      {...(options.createSync === undefined ? {} : { createSync: options.createSync })}
      // The idle-lock platform inputs (task 133). Both are REQUIRED props on `Root`, so this fixture
      // cannot silently stop supplying them; the defaults above make every other test's behaviour
      // identical to before (a timer that never fires drives no tick).
      appState={options.appState ?? fakeAppState()}
      timer={options.timer ?? manualTimer()}
      createSession={async (booted, appRuntime) => {
        const controller = await createAppSession({
          app: booted,
          runtime: appRuntime,
          crypto: noblePort,
          clock: sessionClock,
          idSource: createUuidV7Generator({
            now: () => FIXED_NOW,
            randomBytes: (n) => prngBytes(mulberry32(7), n),
          }),
        });
        if (controller !== null) options.onSessionController?.(controller);
        return controller;
      }}
      // THE PRODUCTION SEAM CHOICE, not a fixture-local one (task 130): `notesMediaSeamsFor` is the
      // same function `index.ts` calls, so what this lane binds into the notes runtime is what a
      // device binds. It was `UNWIRED_NOTES_MEDIA` unconditionally here, which meant the composed
      // lane could not have observed a wired capture even after one existed.
      createNotes={(booted, appRuntime, identity, media, capturePhoto) =>
        createSessionNotesRuntime({
          app: booted,
          runtime: appRuntime,
          identity,
          media: notesMediaSeamsFor(media, capturePhoto),
        })
      }
      {...(options.createMedia === undefined ? {} : { createMedia: options.createMedia })}
      capturePlatform={options.capturePlatform}
      // Push (task 135) — undefined unless a test opts in, so every other live-shell test is unchanged.
      createPushRegistration={options.createPushRegistration}
      pushRouter={options.pushRouter}
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
