// The mobile command-runtime composition's LIVENESS wiring (task 102; task 40's bound, ACTIVATED).
//
// Task 40 built + tested + falsified the mechanism in @bolusi/core: a `RuntimeTimerPort`-bounded
// denial-audit emit so a never-settling client op-append (a stuck op-sqlite WAL lock) on the deny
// path cannot wedge `execute()` forever. But that bound is OPTIONAL and OFF unless the composition
// root injects a timer — and until task 102 `apps/mobile/src/bootstrap/runtime.ts` composed the
// runtime WITHOUT one, so the shipping app still ran the pre-task-40 UNBOUNDED await. "Typed and
// compiling is not running on the target" (CLAUDE.md §2.11): the mechanism protected nothing on the
// device. This suite proves the WIRING — it drives the REAL `createAppRuntime` composition (NOT the
// bare core fixture task 40 already used), so a green here means production is actually bounded.
//
// FALSIFIED (§2.11): removing the `denialAuditTimer: systemTimer` line from `runtime.ts` makes the
// hung emit unbounded again — the bound is never armed, the fake clock cannot free `execute()`, and
// the "settles once the bound elapses" assertion fails CLEANLY (still pending ≠ settled). That is a
// discriminating RED, not a runner hang (T-17): `track()` observes settlement without awaiting the
// wedged promise, so the test always terminates. Restore the line → green. Reported in task 102.
//
// WHAT THIS LANE PROVES, AND WHAT IT DOES NOT. It proves the production composition path
// (`createAppRuntime` → `runtimeFor` → `createModuleRuntime`) passes a working `RuntimeTimerPort`,
// so a denied command whose audit append hangs still denies within the bound. It does NOT re-prove
// core's `#recordBounded` internals (task 40's `permission.test.ts` owns those) — this is the
// activation half, the same shape as task 43 (server) → task 97 (client registration).
import {
  createUuidV7Generator,
  DENIAL_AUDIT_EMIT_TIMEOUT_MS,
  DomainError,
  type CommandDefinition,
  type DeviceIdentity,
  type LocationPort,
  type SigningKeyPort,
} from '@bolusi/core';
import { mulberry32, noblePort, randomBytes as prngBytes } from '@bolusi/test-support';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// The SQLCipher key store reads `expo-secure-store` (a native module that cannot load under Node),
// so mock it exactly as `enrollment.test.ts` does — an in-memory Map. This test never exercises the
// keystore's security surface; it only needs `bootstrap()` to reach a migrated, registered DB.
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
import { createAppRuntime, type AppRuntimeDeps } from './runtime.js';
import { SecureStoreDbKeyStore } from '../ports/db-keystore.js';
import { openBetterSqlite3Driver } from '../../test/better-sqlite3-driver.js';

const FIXED_NOW = 1_726_000_000_000;
const clock = { now: () => FIXED_NOW };
const nullLocation: LocationPort = { getBestFix: () => null };

// A CSPRNG stand-in for the SQLCipher key mint: deterministic per run (T-6) but different on every
// call, so a "reused key" bug cannot pass by accident (the bootstrap.test.ts lesson).
let nonce = 0;
const dbFakeCrypto = {
  randomBytes: (length: number) => {
    nonce += 1;
    return Uint8Array.from({ length }, (_, i) => (i * 7 + nonce * 31 + 3) & 0xff);
  },
} as unknown as Parameters<typeof bootstrap>[0]['crypto'];

// A valid 32-byte Ed25519 seed. `#emitSanctioned` reads `getSigningKey()` while BUILDING the append
// args, before `store.transaction` — so the deny path calls it even though the append itself hangs.
const signingKey: SigningKeyPort = {
  getSigningKey: () => Uint8Array.from({ length: 32 }, (_, i) => (i + 1) & 0xff),
};

const TENANT_ID = '00000000-0000-4000-8000-00000000b001';
const STORE_ID = '00000000-0000-4000-8000-00000000c001';
const DEVICE_ID = '00000000-0000-4000-8000-00000000e001';
// A user with NO directory grants — the primed evaluator denies it any permission (fail-closed).
const GRANTLESS_USER_ID = '00000000-0000-4000-8000-00000000a001';

const device: DeviceIdentity = { tenantId: TENANT_ID, storeId: STORE_ID, deviceId: DEVICE_ID };

function deps(): AppRuntimeDeps {
  const prng = mulberry32(0x102);
  return {
    crypto: noblePort,
    clock,
    idSource: createUuidV7Generator({
      now: () => FIXED_NOW,
      randomBytes: (n: number) => prngBytes(prng, n),
    }),
    location: nullLocation,
    signingKey,
    syncScheduler: { schedule: () => undefined },
  };
}

// A command that requires a real, registered permission the grant-less user lacks — so step 2 of the
// §5.1 sequence denies BEFORE the handler. The handler throws: reaching it would mean the deny leaked.
const deniedCommand: CommandDefinition<Record<string, unknown>> = {
  name: 'test.denied_by_grantless_user',
  permission: 'platform.conflict_acknowledge',
  input: { parse: (raw: unknown) => (raw ?? {}) as Record<string, unknown> },
  handler: () => {
    throw new Error('handler must never run on a denied command (04 §5.1 step 2)');
  },
};

let app: Bootstrapped;

beforeEach(async () => {
  nonce = 0;
  app = await bootstrap({
    driverFactory: openBetterSqlite3Driver,
    keyStore: new SecureStoreDbKeyStore(dbFakeCrypto),
    crypto: dbFakeCrypto,
    clock,
    databaseLocation: ':memory:',
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
  await SecureStore.deleteItemAsync('bolusi.db_encryption_key');
  vi.clearAllMocks();
});

/** Drain the microtask queue (native promise jobs — NOT faked by `vi.useFakeTimers`) so the
 *  deny→emit→race→begin chain runs to the hang without advancing the fake clock. Not a sleep (T-6). */
async function drainMicrotasks(turns = 50): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

/** Observe a promise's settlement WITHOUT awaiting it, so a still-wedged `execute` cannot hang the
 *  test runner (T-17: the RED must be a clean assertion failure, never an infinite runner hang). */
function track(p: Promise<unknown>): { settled: boolean; error?: unknown } {
  const state: { settled: boolean; error?: unknown } = { settled: false };
  p.then(
    () => {
      state.settled = true;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}

/** Rows of a given op type currently in the client `operations` table. */
async function opsOfType(type: string): Promise<unknown[]> {
  return app.db.db.selectFrom('operations').selectAll().where('type', '=', type).execute();
}

test('a HUNG denial-audit emit does not wedge the PRODUCTION runtime — execute denies within task 40s bound (task 102 wiring)', async () => {
  // Compose the runtime EXACTLY as `runtime.ts` does, but over an `app` whose op-store transaction
  // hangs at `begin()`. That is the one attacker-reachable await on the deny path (enforce.ts): every
  // denial emits `auth.permission_denied`, and a denial is the one thing a denied actor triggers at
  // will. `createDirectorySource(app.db.db)` still reads the real (empty) directory, so ONLY the
  // append hangs — the evaluator still decides "denied" synchronously.
  let hangArmed = false;
  let hangEntered = false;
  const hungApp: Bootstrapped = {
    ...app,
    db: {
      ...app.db,
      driver: {
        ...app.db.driver,
        begin: () => {
          if (hangArmed) {
            hangEntered = true;
            return new Promise<void>(() => {
              // never resolves — the stuck WAL lock, reproduced
            });
          }
          return app.db.driver.begin();
        },
      },
    },
  };

  const appRuntime = createAppRuntime(hungApp, deps());
  // Production primes the evaluator once the directory exists (02 §6 bootstrap rule); Root does this.
  // Over the empty directory the grant-less user is denied any permission — fail-closed, not a bug.
  await appRuntime.evaluator.prime();
  const runtime = appRuntime.runtimeFor(device);
  const ctx = runtime.createContext(GRANTLESS_USER_ID);

  // Fake timers so the app's REAL `systemTimer` (a `setTimeout` binding) is controllable — this
  // exercises the actual production timer that `runtime.ts` wires, under a fake clock (T-6).
  vi.useFakeTimers();

  hangArmed = true;
  const p = runtime.execute(deniedCommand, {}, ctx);
  const tracked = track(p);

  // The emit REACHED the hung append (T-14b: a wedge you never reached is not the wedge), and the
  // bound has not elapsed, so execute is genuinely pending — not settled for some unrelated reason.
  await drainMicrotasks();
  expect(hangEntered, 'the audit emit must actually reach the hanging op-store begin()').toBe(true);
  expect(tracked.settled, 'still pending while the emit hangs and the bound has not elapsed').toBe(
    false,
  );

  // The task-40 bound elapses on the REAL wired timer. Without the wiring (line removed) no timeout
  // is ever armed, so this advance frees nothing and the next assertion fails cleanly.
  await vi.advanceTimersByTimeAsync(DENIAL_AUDIT_EMIT_TIMEOUT_MS);

  // The wedge is gone: execute settled, and it DENIED — the wiring activated the bound.
  expect(
    tracked.settled,
    'execute must settle once task 40s bound elapses (the wiring is live)',
  ).toBe(true);
  expect(tracked.error).toBeInstanceOf(DomainError);
  expect((tracked.error as DomainError).code).toBe('PERMISSION_DENIED');

  // The deny is UNCONDITIONAL on the audit (the §6 guarantee task 40 must not weaken): the hung
  // append wrote nothing, yet the command still denied.
  expect(
    await opsOfType('auth.permission_denied'),
    'the hung append landed no audit op — the deny did not wait on it',
  ).toEqual([]);
});
