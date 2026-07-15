// Wires the real production `createApp` against the identity test DB (RLS-enforcing forTenant +
// D14 AuthDirectory) with injected fakes at the crypto/clock/rate-limit seams (T-7). No mocking of
// the middleware chain — the real chain runs; app.fetch drives it (L4). Also provisions tenants
// through the real CLI code path so tests exercise the same provisioning as production.
import { ed25519 } from '@noble/curves/ed25519.js';

import { createApp } from '../../src/app.js';
import { noblePasswordKdf, sha256Hex, type PasswordKdf } from '../../src/crypto/index.js';
import { uuidv7 } from '../../src/uuidv7.js';
import {
  provisionTenant,
  type ProvisionOpts,
  type ProvisionResult,
} from '../../src/cli/provision-tenant.js';
import { InMemoryWindowLimitStore } from '../../src/identity/rate-limits.js';
import { RevocationHooks } from '../../src/identity/revocation.js';
import { makeFakeClock, type FakeClock } from './app.js';
import { makeIdentityDb, makeStubKdf, type IdentityDb } from './identity-db.js';

export interface IdentityHarness {
  readonly app: ReturnType<typeof createApp>;
  readonly idb: IdentityDb;
  readonly clock: FakeClock;
  readonly rateStore: InMemoryWindowLimitStore;
  readonly hooks: RevocationHooks;
  readonly kdf: PasswordKdf;
  readonly dummyCalls: () => number;
  close(): Promise<void>;
}

export async function makeIdentityHarness(
  opts: { realKdf?: boolean } = {},
): Promise<IdentityHarness> {
  const idb = await makeIdentityDb();
  const clock = makeFakeClock();
  const { kdf, dummyCalls } = opts.realKdf
    ? { kdf: noblePasswordKdf, dummyCalls: () => 0 }
    : makeStubKdf();
  const rateStore = new InMemoryWindowLimitStore();
  const hooks = new RevocationHooks();
  const app = createApp({
    now: () => clock.now(),
    forTenant: idb.forTenant,
    authDirectory: idb.authDirectory,
    passwordKdf: kdf,
    identityRateStore: rateStore,
    revocationHooks: hooks,
  });
  return { app, idb, clock, rateStore, hooks, kdf, dummyCalls, close: () => idb.close() };
}

/** Provision a tenant through the real CLI code path, using the harness's clock + KDF. */
export function provision(h: IdentityHarness, opts: ProvisionOpts): Promise<ProvisionResult> {
  return provisionTenant(
    {
      forTenant: h.idb.forTenant,
      now: () => h.clock.now(),
      createPasswordVerifier: h.kdf.createVerifier,
      generatePassword: () => 'Owner1PasswordBase58xyz9', // 24 chars; returned as oneTimePassword
      generateSystemKeypair: () => {
        const { secretKey, publicKey } = ed25519.keygen();
        return {
          publicKeyB64: Buffer.from(publicKey).toString('base64'),
          secretKeyB64: Buffer.from(secretKey).toString('base64'),
        };
      },
    },
    opts,
  );
}

const BASE = 'http://srv.test';

/** POST /v1/auth/login and return the parsed body + status. */
export async function login(
  h: IdentityHarness,
  loginIdentifier: string,
  password: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await h.app.request(`${BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginIdentifier, password }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** POST /v1/devices/enroll with a control session bearer + Idempotency-Key. */
export async function enroll(
  h: IdentityHarness,
  controlSession: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<Response> {
  return h.app.request(`${BASE}/v1/devices/enroll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${controlSession}`,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

// ---- direct-seed helpers (owner handle; faster + more controlled than driving the API) ----------

/** Insert a control-session row for `userId`; returns its `bcs_` token. */
export async function seedControlSession(
  h: IdentityHarness,
  params: { tenantId: string; userId: string; expiresAt?: number },
): Promise<string> {
  const token = `bcs_${uuidv7(h.clock.now()).replace(/-/g, '')}test`;
  await h.idb.db
    .insertInto('controlSessions')
    .values({
      id: uuidv7(h.clock.now()),
      tenantId: params.tenantId,
      userId: params.userId,
      tokenHash: sha256Hex(token),
      createdAt: BigInt(h.clock.now()),
      expiresAt: BigInt(params.expiresAt ?? h.clock.now() + 600_000),
    })
    .execute();
  return token;
}

/** Insert an active device row; returns { deviceId, token }. */
export async function seedDevice(
  h: IdentityHarness,
  params: { tenantId: string; storeId: string; enrolledBy?: string | null; deviceId?: string },
): Promise<{ deviceId: string; token: string }> {
  const deviceId = params.deviceId ?? uuidv7(h.clock.now());
  const token = `bdt_${uuidv7(h.clock.now()).replace(/-/g, '')}test`;
  await h.idb.db
    .insertInto('devices')
    .values({
      id: deviceId,
      tenantId: params.tenantId,
      storeId: params.storeId,
      kind: 'member',
      name: `device-${deviceId}`,
      signingKeyPublic: `pk-${deviceId}`,
      tokenHash: sha256Hex(token),
      enrolledAt: BigInt(h.clock.now()),
      enrolledBy: params.enrolledBy ?? null,
      status: 'active',
    })
    .execute();
  return { deviceId, token };
}

/** Look up a role id by roleKey (name) within a tenant. */
export async function roleIdOf(
  h: IdentityHarness,
  tenantId: string,
  roleKey: string,
): Promise<string> {
  const row = await h.idb.db
    .selectFrom('roles')
    .select('id')
    .where('tenantId', '=', tenantId)
    .where('name', '=', roleKey)
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Insert a user + store memberships + role grants. Store-scoped roles get one grant per store. */
export async function seedUser(
  h: IdentityHarness,
  params: {
    tenantId: string;
    name: string;
    loginIdentifier?: string | null;
    passwordVerifier?: string | null;
    status?: 'active' | 'deactivated';
    storeIds: string[];
    roleKeys: string[];
  },
): Promise<string> {
  const userId = uuidv7(h.clock.now());
  await h.idb.db
    .insertInto('users')
    .values({
      id: userId,
      tenantId: params.tenantId,
      name: params.name,
      loginIdentifier: params.loginIdentifier ?? null,
      passwordVerifier: params.passwordVerifier ?? null,
      status: params.status ?? 'active',
      isSystem: false,
      createdAt: BigInt(h.clock.now()),
      createdBy: null,
    })
    .execute();
  for (const storeId of params.storeIds) {
    await h.idb.db
      .insertInto('userStores')
      .values({ userId, storeId, tenantId: params.tenantId })
      .execute();
  }
  for (const roleKey of params.roleKeys) {
    const rid = await roleIdOf(h, params.tenantId, roleKey);
    const role = await h.idb.db
      .selectFrom('roles')
      .select('scopeType')
      .where('id', '=', rid)
      .executeTakeFirstOrThrow();
    if (role.scopeType === 'tenant') {
      await h.idb.db
        .insertInto('userRoles')
        .values({ tenantId: params.tenantId, userId, roleId: rid, storeId: null })
        .execute();
    } else {
      for (const storeId of params.storeIds) {
        await h.idb.db
          .insertInto('userRoles')
          .values({ tenantId: params.tenantId, userId, roleId: rid, storeId })
          .execute();
      }
    }
  }
  return userId;
}
