// A blocked device erases itself at its next start, but only once the server confirms the block.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEVICE_ID_META_KEY, DEVICE_REVOKED_REASON, writeMeta, writeSyncState } from '@bolusi/core';
import { nodeColumnAead, noblePort } from '@bolusi/test-support';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { openBetterSqlite3Driver } from '../../test/better-sqlite3-driver.js';
import { SecretDbKeyStore, type SecretsPort } from '../ports/secret-keystores.js';
import {
  bootErasingBlocked,
  createBlockProbe,
  isBlockedSyncState,
  type BlockCheck,
} from './blocked-wipe.js';
import { bootstrap, type Bootstrapped } from './bootstrap.js';
import { resolveShellInputs } from './shell-inputs.js';

const clock = { now: () => 1_765_000_000_000 };

function memorySecrets(): SecretsPort & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (name) => Promise.resolve(map.get(name) ?? null),
    set: (name, value) => {
      map.set(name, value);
      return Promise.resolve();
    },
    delete: (name) => {
      map.delete(name);
      return Promise.resolve();
    },
  };
}

let dir: string;
let dbPath: string;
let secrets: ReturnType<typeof memorySecrets>;
let dbKeys: SecretDbKeyStore;
let open: Bootstrapped[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bolusi-blocked-'));
  dbPath = join(dir, 'bolusi.db');
  secrets = memorySecrets();
  dbKeys = new SecretDbKeyStore(secrets, noblePort);
  open = [];
});

afterEach(async () => {
  for (const app of open) await app.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

async function boot(): Promise<Bootstrapped> {
  const app = await bootstrap({
    driverFactory: openBetterSqlite3Driver,
    keyStore: dbKeys,
    aead: nodeColumnAead,
    crypto: noblePort,
    clock,
    databaseLocation: dbPath,
  });
  open.push(app);
  return app;
}

/** A registered device whose sync loop recorded DEVICE_REVOKED, then closed. */
async function blockedDevice(): Promise<void> {
  const app = await boot();
  await writeMeta(app.db.db as never, DEVICE_ID_META_KEY, '019a0000-0000-7000-8000-000000000001');
  await writeSyncState(app.db.db as never, {
    syncDisabled: true,
    syncDisabledReason: DEVICE_REVOKED_REASON,
    lastSyncError: 'DEVICE_REVOKED',
  });
  secrets.map.set('bolusi.device_token', 'bdt_test');
  await app.close();
}

function eraser(steps: string[]) {
  return async () => {
    steps.push('media');
    await dbKeys.wipe();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
    steps.push('database');
    secrets.map.delete('bolusi.device_token');
    steps.push('keys');
  };
}

describe('bootErasingBlocked', () => {
  test('an unblocked device boots untouched and the server is not asked', async () => {
    const probe = vi.fn(async (): Promise<BlockCheck> => 'blocked');
    const erase = vi.fn(async () => undefined);
    const app = await bootErasingBlocked({ boot, probe, eraseDevice: erase, clock });
    expect(app.wipedAfterBlock).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    expect(erase).not.toHaveBeenCalled();
  });

  test('a confirmed block erases the device and setup says why, also after a restart', async () => {
    await blockedDevice();
    const steps: string[] = [];
    const app = await bootErasingBlocked({
      boot,
      probe: async () => 'blocked',
      eraseDevice: eraser(steps),
      clock,
    });

    expect(steps).toEqual(['media', 'database', 'keys']);
    expect(app.deviceId).toBeNull();
    expect(app.wipedAfterBlock).toBe(true);
    expect(isBlockedSyncState(app.syncState)).toBe(false);
    expect(resolveShellInputs(app, null, clock.now()).device).toBe('revoked');
    expect(secrets.map.has('bolusi.device_token')).toBe(false);

    await app.close();
    const again = await boot();
    expect(again.wipedAfterBlock).toBe(true);
    expect(resolveShellInputs(again, null, clock.now()).device).toBe('revoked');
  });

  test('no answer from the server erases nothing and keeps the device locked', async () => {
    await blockedDevice();
    const erase = vi.fn(async () => undefined);
    const app = await bootErasingBlocked({
      boot,
      probe: async () => 'unknown',
      eraseDevice: erase,
      clock,
    });
    expect(erase).not.toHaveBeenCalled();
    expect(app.deviceId).not.toBeNull();
    expect(isBlockedSyncState(app.syncState)).toBe(true);
    expect(resolveShellInputs(app, null, clock.now()).device).toBe('revoked');
    expect(existsSync(dbPath)).toBe(true);
  });

  test('a probe that throws counts as no answer', async () => {
    await blockedDevice();
    const erase = vi.fn(async () => undefined);
    await bootErasingBlocked({
      boot,
      probe: () => Promise.reject(new Error('boom')),
      eraseDevice: erase,
      clock,
    });
    expect(erase).not.toHaveBeenCalled();
  });

  test('a server that still knows the device clears the record and sync resumes', async () => {
    await blockedDevice();
    const erase = vi.fn(async () => undefined);
    const app = await bootErasingBlocked({
      boot,
      probe: async () => 'not_blocked',
      eraseDevice: erase,
      clock,
    });
    expect(erase).not.toHaveBeenCalled();
    expect(isBlockedSyncState(app.syncState)).toBe(false);
    expect(app.syncState.lastSyncError).toBeNull();
    expect(resolveShellInputs(app, null, clock.now()).device).toBe('active');
  });

  test('an unrecognised device is not erased', async () => {
    const app = await boot();
    await writeSyncState(app.db.db as never, {
      syncDisabled: true,
      syncDisabledReason: 'device_unrecognised',
    });
    await app.close();
    const probe = vi.fn(async (): Promise<BlockCheck> => 'blocked');
    await bootErasingBlocked({ boot, probe, eraseDevice: async () => undefined, clock });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('createBlockProbe', () => {
  const answer = (status: number, body: unknown) =>
    vi.fn(async () =>
      typeof body === 'string'
        ? new Response(body, { status })
        : new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
          }),
    );
  const probeWith = (fetchImpl: typeof fetch, token: string | null = 'bdt_x') =>
    createBlockProbe({
      baseUrl: 'https://api.test',
      deviceToken: async () => token,
      fetchImpl,
    });

  test('only the server saying DEVICE_REVOKED is a block', async () => {
    const revoked = answer(401, { error: { code: 'DEVICE_REVOKED', message: 'Device revoked' } });
    expect(await probeWith(revoked as unknown as typeof fetch)()).toBe('blocked');
    expect(revoked).toHaveBeenCalledWith(
      'https://api.test/v1/devices/me',
      expect.objectContaining({ headers: { Authorization: 'Bearer bdt_x' } }),
    );
  });

  test.each([
    ['another 401 code', 401, { error: { code: 'AUTH_TOKEN_INVALID', message: 'x' } }],
    ['a portal page', 401, '<html>login</html>'],
    ['a server error', 500, { error: { code: 'INTERNAL', message: 'x' } }],
  ])('%s is no answer', async (_name, status, body) => {
    expect(await probeWith(answer(status, body) as unknown as typeof fetch)()).toBe('unknown');
  });

  test('a normal answer means the device is not blocked', async () => {
    expect(await probeWith(answer(200, { deviceId: 'x' }) as unknown as typeof fetch)()).toBe(
      'not_blocked',
    );
  });

  test('a network failure is no answer', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('network down');
    });
    expect(await probeWith(down as unknown as typeof fetch)()).toBe('unknown');
  });

  test('a recorded block with no token left finishes an interrupted erase', async () => {
    const fetchImpl = vi.fn();
    expect(await probeWith(fetchImpl as unknown as typeof fetch, null)()).toBe('blocked');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
