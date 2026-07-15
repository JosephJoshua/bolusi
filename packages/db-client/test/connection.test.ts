// Open-path unit tests against a FAKE driver (task 04 acceptance).
//
// A fake — not better-sqlite3 — because these tests are about what the wrapper DOES to
// the driver: how many times it opens, what key it passes, which pragmas it issues in
// which order, and what it refuses to do when the key is wrong or missing. A real driver
// would hide exactly those observations.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  CLIENT_PRAGMAS,
  closeClientDb,
  DbOpenError,
  DEFAULT_DATABASE_NAME,
  getClientDb,
  isClientDbOpen,
  openClientDb,
} from '../src/connection.js';
import type { DbDriver, DbDriverOpenParams, DbQueryResult } from '../src/driver.js';

// Stand-in for the real SQLCipher key (32 CSPRNG bytes as hex — 10-db §9). Deliberately
// an obviously-fake, low-entropy literal: a realistic random hex string here trips the
// mandatory secret scanner (security-guide §10, SEC-SECRET-02), and nothing these tests
// prove depends on the value's shape — redaction is a plain string replace, and the fake
// driver never parses it.
const FAKE_DB_KEY = 'fake-sqlcipher-key-for-tests-never-a-real-secret';

/** Awaits an open that MUST fail and returns the thrown error. Fails loudly if the open
 * unexpectedly succeeds — a silent success here would vacate the assertions that follow. */
async function expectOpenToFail(promise: Promise<unknown>): Promise<DbOpenError> {
  return promise.then(
    () => {
      throw new Error('expected openClientDb to reject, but it resolved');
    },
    (thrown: unknown) => {
      if (!(thrown instanceof DbOpenError)) {
        throw new Error(`expected a DbOpenError, got ${String(thrown)}`);
      }
      return thrown;
    },
  );
}

const EMPTY_RESULT: DbQueryResult = { rows: [], rowsAffected: 0, insertId: null };

interface FakeDriverLog {
  /** Every `driverFactory` invocation, in order — the single-handle witness. */
  readonly opens: DbDriverOpenParams[];
  readonly executed: string[];
  closes: number;
}

function createFakeDriver(log: FakeDriverLog): DbDriver {
  return {
    execute(sql: string): Promise<DbQueryResult> {
      log.executed.push(sql);
      return Promise.resolve(EMPTY_RESULT);
    },
    executeBatch: () => Promise.resolve({ rowsAffected: 0 }),
    prepare: () => ({
      execute: () => Promise.resolve(EMPTY_RESULT),
      finalize: () => Promise.resolve(),
    }),
    begin: () => Promise.resolve(),
    commit: () => Promise.resolve(),
    rollback: () => Promise.resolve(),
    close: () => {
      log.closes += 1;
      return Promise.resolve();
    },
  };
}

function createHarness(options: { key?: string | null; openFails?: Error } = {}) {
  const log: FakeDriverLog = { opens: [], executed: [], closes: 0 };
  const getDatabaseEncryptionKey = vi.fn(() =>
    Promise.resolve(options.key === undefined ? FAKE_DB_KEY : options.key),
  );
  const driverFactory = vi.fn((params: DbDriverOpenParams) => {
    log.opens.push(params);
    if (options.openFails) return Promise.reject(options.openFails);
    return Promise.resolve(createFakeDriver(log));
  });
  return { log, driverFactory, keyStore: { getDatabaseEncryptionKey } };
}

afterEach(async () => {
  await closeClientDb();
});

describe('open path', () => {
  test('reads the key via the injected getter exactly once and passes it as encryptionKey', async () => {
    const h = createHarness();
    await openClientDb({ driverFactory: h.driverFactory, keyStore: h.keyStore });

    expect(h.keyStore.getDatabaseEncryptionKey).toHaveBeenCalledTimes(1);
    expect(h.log.opens).toEqual([
      { name: DEFAULT_DATABASE_NAME, location: undefined, encryptionKey: FAKE_DB_KEY },
    ]);
  });

  test('applies the spec pragmas post-open, in order', async () => {
    const h = createHarness();
    await openClientDb({ driverFactory: h.driverFactory, keyStore: h.keyStore });

    // 10-db §9 preamble: WAL first — it is what makes one connection sufficient.
    expect(h.log.executed.slice(0, CLIENT_PRAGMAS.length)).toEqual([
      'PRAGMA journal_mode = WAL',
      'PRAGMA foreign_keys = ON',
      'PRAGMA busy_timeout = 5000',
      'PRAGMA synchronous = NORMAL',
    ]);
    expect(CLIENT_PRAGMAS).toEqual(h.log.executed.slice(0, CLIENT_PRAGMAS.length));
  });

  test('honours an explicit database name and location', async () => {
    const h = createHarness();
    await openClientDb({
      driverFactory: h.driverFactory,
      keyStore: h.keyStore,
      name: 'other.db',
      location: ':memory:',
    });

    expect(h.log.opens[0]).toMatchObject({ name: 'other.db', location: ':memory:' });
  });
});

describe('single-connection invariant', () => {
  // op-sqlite allows exactly ONE connection per database app-wide (08 §2.2). This is the
  // rule the whole wrapper exists to hold.
  test('a second open while a connection is live throws', async () => {
    const h = createHarness();
    await openClientDb({ driverFactory: h.driverFactory, keyStore: h.keyStore });

    await expect(
      openClientDb({ driverFactory: h.driverFactory, keyStore: h.keyStore }),
    ).rejects.toMatchObject({ name: 'DbOpenError', code: 'already_open' });
    expect(h.driverFactory).toHaveBeenCalledTimes(1);
  });

  test('close then open succeeds', async () => {
    const h = createHarness();
    const first = await openClientDb({ driverFactory: h.driverFactory, keyStore: h.keyStore });
    await first.close();
    expect(isClientDbOpen()).toBe(false);
    expect(h.log.closes).toBe(1);

    await openClientDb({ driverFactory: h.driverFactory, keyStore: h.keyStore });
    expect(isClientDbOpen()).toBe(true);
    expect(h.driverFactory).toHaveBeenCalledTimes(2);
  });

  test('the Kysely dialect and the raw helpers share one driver handle', async () => {
    const h = createHarness();
    const connection = await openClientDb({
      driverFactory: h.driverFactory,
      keyStore: h.keyStore,
    });

    // Drive both surfaces, then prove no extra handle was ever constructed.
    await connection.db.selectFrom('metaKv').select('key').execute();
    await connection.driver.execute('SELECT 1');

    expect(h.driverFactory).toHaveBeenCalledTimes(1);
    expect(h.log.opens).toHaveLength(1);
  });

  test('getClientDb throws when nothing is open and returns the live handle otherwise', async () => {
    expect(() => getClientDb()).toThrow(DbOpenError);

    const h = createHarness();
    const connection = await openClientDb({ driverFactory: h.driverFactory, keyStore: h.keyStore });
    expect(getClientDb()).toBe(connection);
  });
});

describe('transaction helper', () => {
  test('commits on success and rolls back on throw', async () => {
    const h = createHarness();
    const connection = await openClientDb({ driverFactory: h.driverFactory, keyStore: h.keyStore });
    const commit = vi.spyOn(connection.driver, 'commit');
    const rollback = vi.spyOn(connection.driver, 'rollback');

    await expect(connection.transaction(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(commit).toHaveBeenCalledTimes(1);

    await expect(
      connection.transaction(() => Promise.reject(new Error('UNIQUE constraint failed: t.id'))),
    ).rejects.toMatchObject({ name: 'DbError', code: 'constraint' });
    expect(rollback).toHaveBeenCalledTimes(1);
  });
});

// The CI leg of SEC-DEV-06 (security-guide §6.5). CI cannot witness ciphertext at rest —
// better-sqlite3 has no SQLCipher — so what is provable here is that the wrapper NEVER
// opens a database unkeyed and never leaks the key. The on-device leg (real SQLCipher,
// file bytes) is `checkDbAtRestIsCiphertext` in @bolusi/test-support, run by task 27.
describe('SEC-DEV-06 DB at rest is ciphertext', () => {
  let captured: string[];
  const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;

  beforeEach(() => {
    captured = [];
    for (const method of consoleMethods) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((arg) => String(arg)).join(' '));
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('wrong key: driver open error surfaces as a typed DbOpenError with no unkeyed retry', async () => {
    const h = createHarness({ openFails: new Error('file is not a database') });

    await expect(
      openClientDb({ driverFactory: h.driverFactory, keyStore: h.keyStore }),
    ).rejects.toMatchObject({ name: 'DbOpenError', code: 'driver_open_failed' });

    // Exactly one open attempt, and it carried the key. A retry — or any attempt with a
    // missing/blank encryptionKey — would be a silent plaintext-fallback path.
    expect(h.driverFactory).toHaveBeenCalledTimes(1);
    expect(h.log.opens).toHaveLength(1);
    for (const attempt of h.log.opens) {
      expect(attempt.encryptionKey).toBe(FAKE_DB_KEY);
    }
    expect(isClientDbOpen()).toBe(false);
  });

  test('missing key: throws before the driver is ever called', async () => {
    const h = createHarness({ key: null });

    await expect(
      openClientDb({ driverFactory: h.driverFactory, keyStore: h.keyStore }),
    ).rejects.toMatchObject({ name: 'DbOpenError', code: 'missing_key' });
    expect(h.driverFactory).not.toHaveBeenCalled();
  });

  test('empty key is treated as missing, not as "open it unencrypted"', async () => {
    const h = createHarness({ key: '' });

    await expect(
      openClientDb({ driverFactory: h.driverFactory, keyStore: h.keyStore }),
    ).rejects.toMatchObject({ name: 'DbOpenError', code: 'missing_key' });
    expect(h.driverFactory).not.toHaveBeenCalled();
  });

  test('key bytes never reach an error message, an error cause, or a log line', async () => {
    // A driver that echoes its params back in the failure — the realistic leak.
    const h = createHarness({
      openFails: new Error(`unable to open with encryptionKey=${FAKE_DB_KEY}`),
    });

    const error = await expectOpenToFail(
      openClientDb({ driverFactory: h.driverFactory, keyStore: h.keyStore }),
    );

    expect(error.message).not.toContain(FAKE_DB_KEY);
    expect(error.message).toContain('[redacted]');
    const cause = error.cause as Error;
    expect(cause.message).not.toContain(FAKE_DB_KEY);
    expect(JSON.stringify(captured)).not.toContain(FAKE_DB_KEY);
    // The whole serialized error, as a logger would render it.
    expect(`${error.stack ?? ''}${cause.stack ?? ''}`).not.toContain(FAKE_DB_KEY);
  });

  test('pragma failure after a successful open closes the driver and redacts the key', async () => {
    const log: FakeDriverLog = { opens: [], executed: [], closes: 0 };
    const driverFactory = vi.fn((params: DbDriverOpenParams) => {
      log.opens.push(params);
      const driver = createFakeDriver(log);
      return Promise.resolve({
        ...driver,
        execute: () => Promise.reject(new Error(`pragma failed for key ${FAKE_DB_KEY}`)),
      });
    });

    const error = await expectOpenToFail(
      openClientDb({
        driverFactory,
        keyStore: { getDatabaseEncryptionKey: () => Promise.resolve(FAKE_DB_KEY) },
      }),
    );

    expect(error.message).not.toContain(FAKE_DB_KEY);
    // A half-open connection must not linger as the singleton.
    expect(log.closes).toBe(1);
    expect(isClientDbOpen()).toBe(false);
  });
});
