// Persisting the bundle into the client directory (api/02-auth §5.2) — the four directory tables,
// the greatest-`asOf` verifier merge (§5.3), and verifier minimization on deactivation/unassignment
// (§5.1/§5.2). Runs against a real better-sqlite3 client DB behind the real dialect + migrations.
import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createClientDialect,
  runClientMigrations,
  type ClientDatabase,
  type DbDriver,
} from '@bolusi/db-client';
import { noblePort } from '@bolusi/test-support';

import {
  applyBundle,
  buildPinVerifier,
  FLOOR_KDF_PARAMS,
  readMeta,
  readVerifier,
  VerifierBoundsError,
  writeVerifier,
  type BundleUser,
  type CanonicalRef,
  type DeviceBundle,
  type PinVerifier,
} from '../../src/index.js';
import { openMemoryDriver } from '../projection/better-sqlite3-driver.js';

const REAL_DEVICE = 'a1111111-1111-7111-8111-111111111111';
const NIL = '00000000-0000-0000-0000-000000000000';

function encode(pin: string): Uint8Array {
  const out = new Uint8Array(pin.length);
  for (let i = 0; i < pin.length; i += 1) out[i] = pin.charCodeAt(i);
  return out;
}

async function verifier(pin: string, asOf: CanonicalRef): Promise<PinVerifier> {
  return buildPinVerifier(
    noblePort,
    encode(pin),
    FLOOR_KDF_PARAMS,
    noblePort.randomBytes(16),
    asOf,
  );
}

function bundle(users: BundleUser[], over: Partial<DeviceBundle> = {}): DeviceBundle {
  return {
    tenant: { id: 'tenant-1', name: 'T' },
    store: { id: 'store-1', name: 'S' },
    settings: { idleLockSeconds: 300 },
    users,
    rolesSnapshot: [
      {
        id: 'role-main',
        name: 'main_owner',
        scopeType: 'tenant',
        isSystemDefault: true,
        permissionIds: ['auth.pin_change'],
      },
    ],
    permissionsSnapshot: [],
    ...over,
  };
}

let driver: DbDriver | null = null;
let db: Kysely<ClientDatabase> | null = null;

async function open(): Promise<Kysely<ClientDatabase>> {
  driver = openMemoryDriver();
  await runClientMigrations(driver, { now: () => 1 });
  db = new Kysely<ClientDatabase>({
    dialect: createClientDialect(driver),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });
  return db;
}

afterEach(async () => {
  await db?.destroy();
  await driver?.close();
  db = null;
  driver = null;
});

async function count(k: Kysely<ClientDatabase>, table: string): Promise<number> {
  const rows = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql.ref(table)}`.execute(k);
  return Number(rows.rows[0]?.n ?? 0);
}

describe('applyBundle — the four directory tables (api/02-auth §5.2)', () => {
  it('writes users, roles, grants, verifiers, and the tenant into meta_kv', async () => {
    const k = await open();
    const users: BundleUser[] = [
      {
        id: 'u-owner',
        name: 'Ocep',
        photoMediaId: null,
        status: 'active',
        grants: [{ roleId: 'role-main', storeId: null }],
        pinVerifier: await verifier('111111', { timestamp: 1000, deviceId: NIL, seq: 0 }),
      },
      {
        id: 'u-staff',
        name: 'Budi',
        photoMediaId: null,
        status: 'active',
        grants: [{ roleId: 'role-main', storeId: 'store-1' }],
        pinVerifier: null,
      },
    ];
    await applyBundle(k, bundle(users));

    expect(await count(k, 'users_directory')).toBe(2);
    expect(await count(k, 'roles_directory')).toBe(1);
    expect(await count(k, 'user_roles_directory')).toBe(2);
    // Only the user WITH a verifier gets a row (u-staff has none).
    expect(await count(k, 'user_pin_verifiers')).toBe(1);
    const tenant = await sql<{
      value: string;
    }>`SELECT value FROM meta_kv WHERE key = 'tenantId'`.execute(k);
    expect(tenant.rows[0]?.value).toBe('tenant-1');
    expect(await readVerifier(k, 'u-owner')).not.toBeNull();
  });

  it('persists the store/tenant display names into meta_kv, refreshing them on a rename (task 109)', async () => {
    const k = await open();
    // First bundle: the store + tenant names as enrolled. The wire keys are asserted LITERALLY
    // ('auth.storeName'/'auth.tenantName') so a write to a WRONG key can't hide behind the same
    // constant the production write uses — this pins the exact key the mobile reader reads (T-15).
    await applyBundle(
      k,
      bundle([], {
        store: { id: 'store-1', name: 'Toko Lama' },
        tenant: { id: 'tenant-1', name: 'PT Lama' },
      }),
    );
    expect(await readMeta(k, 'auth.storeName')).toBe('Toko Lama');
    expect(await readMeta(k, 'auth.tenantName')).toBe('PT Lama');

    // The store + tenant are RENAMED server-side (same ids); the next pull bundle carries the NEW
    // names. Persisting them in applyBundle is what keeps the on-device names fresh across a rename.
    await applyBundle(
      k,
      bundle([], {
        store: { id: 'store-1', name: 'Toko Baru' },
        tenant: { id: 'tenant-1', name: 'PT Baru' },
      }),
    );
    expect(await readMeta(k, 'auth.storeName')).toBe('Toko Baru');
    expect(await readMeta(k, 'auth.tenantName')).toBe('PT Baru');
  });

  it('re-applying is idempotent — the tables do not accumulate', async () => {
    const k = await open();
    const users: BundleUser[] = [
      {
        id: 'u-owner',
        name: 'Ocep',
        photoMediaId: null,
        status: 'active',
        grants: [{ roleId: 'role-main', storeId: null }],
        pinVerifier: null,
      },
    ];
    await applyBundle(k, bundle(users));
    await applyBundle(k, bundle(users));
    expect(await count(k, 'users_directory')).toBe(1);
    expect(await count(k, 'user_roles_directory')).toBe(1);
  });
});

describe('applyBundle — §5.3 merge & §5.2 minimization', () => {
  it('a newer LOCAL verifier survives a staler bundle refresh (greatest-asOf)', async () => {
    const k = await open();
    const stale = await verifier('111111', { timestamp: 1000, deviceId: NIL, seq: 0 });
    await applyBundle(k, bundle([mkUser('u-owner', stale)]));

    // A local PIN change writes a NEWER verifier (real device, later position).
    const localNewer = await verifier('222222', { timestamp: 5000, deviceId: REAL_DEVICE, seq: 7 });
    await writeVerifier(k, 'u-owner', localNewer);

    // A bundle refresh still carrying the STALE verifier must not clobber the local newer one.
    await applyBundle(k, bundle([mkUser('u-owner', stale)]));
    const effective = await readVerifier(k, 'u-owner');
    expect(effective?.asOf).toEqual(localNewer.asOf);
    expect(effective?.hashB64).toBe(localNewer.hashB64);
  });

  it('a NEWER bundle verifier wins over an older local row', async () => {
    const k = await open();
    await writeVerifier(
      k,
      'u-owner',
      await verifier('111111', { timestamp: 1000, deviceId: REAL_DEVICE, seq: 1 }),
    );
    const bundleNewer = await verifier('222222', {
      timestamp: 9000,
      deviceId: REAL_DEVICE,
      seq: 2,
    });
    await applyBundle(k, bundle([mkUser('u-owner', bundleNewer)]));
    expect((await readVerifier(k, 'u-owner'))?.asOf).toEqual(bundleNewer.asOf);
  });

  it('a deactivated user (pinVerifier null) loses their verifier row', async () => {
    const k = await open();
    await applyBundle(
      k,
      bundle([
        mkUser('u-owner', await verifier('111111', { timestamp: 1, deviceId: NIL, seq: 0 })),
      ]),
    );
    expect(await readVerifier(k, 'u-owner')).not.toBeNull();
    // Refresh: same user, now deactivated with no verifier.
    await applyBundle(
      k,
      bundle([
        {
          id: 'u-owner',
          name: 'Ocep',
          photoMediaId: null,
          status: 'deactivated',
          grants: [],
          pinVerifier: null,
        },
      ]),
    );
    expect(await readVerifier(k, 'u-owner')).toBeNull();
    const status = await sql<{
      status: string;
    }>`SELECT status FROM users_directory WHERE id = 'u-owner'`.execute(k);
    expect(status.rows[0]?.status).toBe('deactivated');
  });

  it('a user unassigned from the store (absent from the bundle) loses their verifier row', async () => {
    const k = await open();
    await applyBundle(
      k,
      bundle([
        mkUser('u-owner', await verifier('111111', { timestamp: 1, deviceId: NIL, seq: 0 })),
        mkUser('u-gone', await verifier('222222', { timestamp: 1, deviceId: NIL, seq: 0 })),
      ]),
    );
    expect(await count(k, 'user_pin_verifiers')).toBe(2);
    // u-gone left the store — absent from the refreshed bundle.
    await applyBundle(
      k,
      bundle([
        mkUser('u-owner', await verifier('111111', { timestamp: 1, deviceId: NIL, seq: 0 })),
      ]),
    );
    expect(await readVerifier(k, 'u-gone')).toBeNull();
    expect(await readVerifier(k, 'u-owner')).not.toBeNull();
  });

  it('SEC-AUTH-01 — a hostile bundle verifier (m=1 GiB) is rejected on the device', async () => {
    const k = await open();
    const hostile: PinVerifier = {
      ...(await verifier('111111', { timestamp: 1, deviceId: NIL, seq: 0 })),
      mKiB: 1_048_576,
    };
    await expect(applyBundle(k, bundle([mkUser('u-owner', hostile)]))).rejects.toThrow(
      VerifierBoundsError,
    );
  });
});

function mkUser(id: string, pinVerifier: PinVerifier | null): BundleUser {
  return {
    id,
    name: id,
    photoMediaId: null,
    status: 'active',
    grants: [{ roleId: 'role-main', storeId: null }],
    pinVerifier,
  };
}
