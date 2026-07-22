// The SEC-TENANT-04 probe fixture: the REAL production `@bolusi/server` (`createApp`, full
// middleware chain, real routers) in process on PGlite, seeded with TWO tenants and TWO stores so a
// cross-tenant / unassigned-store probe has something real to address.
//
// WHY NOT `HarnessServer` (src/server.ts). That fixture is the chaos harness's: one tenant, one
// store, device bearers only, and — critically — it leaves `authDirectory` at its production
// default, which reads a module-level `pg` pool that does not exist in-process, so `POST
// /v1/auth/login` cannot be probed through it at all. SEC-TENANT-04 must walk EVERY registered
// route, login included, and needs a control-session bearer for the control-plane routes. Rather
// than widen the chaos fixture (and collide with the scenarios lane), this composes the same
// production pieces for the different contract. It re-implements NO protocol logic (T-7): the app
// is `createApp`, the token verifier is the production `createVerifyToken` over the production
// `InMemoryTokenStore` (@bolusi/server/test-support), and the login lookup calls the SAME
// `auth_find_login_credential` SECURITY DEFINER function the production `findLoginCredential`
// calls — only the handle differs, exactly as `forTenant` does.
import { PGlite } from '@electric-sql/pglite';
import { CamelCasePlugin, Kysely, PGliteDialect, sql } from 'kysely';

import { migrateToLatest, type DB } from '@bolusi/db-server';
import { createApp } from '@bolusi/server';
import { createVerifyToken, InMemoryTokenStore } from '@bolusi/server/test-support';
import { bytesToBase64 } from '@bolusi/core';
import { deriveDeviceKeypair, FakeClock } from '@bolusi/test-support';

import type { ProbeContext } from './route-walker.js';

const CLOCK_BASE = 1_726_100_000_000;
const CREATED_AT = 1_726_000_000_000n;
const APP_ROLE = 'bolusi_app';

/**
 * Fixed ids — a probe report that names an id is reproducible without a seed lookup. Every one is
 * a syntactically valid **UUIDv7** (version nibble `7`, variant `8`): 10-db §2 makes v7 the id
 * format system-wide and the media `:id` param validator is `zUuidV7`, so a v4 id would fail
 * validation (`422 VALIDATION_FAILED`) BEFORE the handler's scope check and every media probe
 * would pass for the wrong reason — a probe that never reaches the code it audits.
 */
const ID = {
  tenantA: '01111111-1111-7111-8111-111111111111',
  tenantB: '02222222-2222-7222-8222-222222222222',
  storeA1: '0a111111-1111-7111-8111-111111111111',
  storeA2: '0a222222-2222-7222-8222-222222222222',
  storeB: '0b111111-1111-7111-8111-111111111111',
  userA1: '0c111111-1111-7111-8111-111111111111',
  userA2: '0c222222-2222-7222-8222-222222222222',
  userB: '0d111111-1111-7111-8111-111111111111',
  deviceA1: '0e111111-1111-7111-8111-111111111111',
  deviceA2: '0e222222-2222-7222-8222-222222222222',
  deviceB: '0f111111-1111-7111-8111-111111111111',
  mediaA2: '0a333333-3333-7333-8333-333333333333',
  mediaAOther: '0a444444-4444-7444-8444-444444444444',
  mediaB: '0b555555-5555-7555-8555-555555555555',
  pushTokenB: '0b666666-6666-7666-8666-666666666666',
  nonexistent: '0f999999-9999-7999-8999-999999999999',
} as const;

const TENANT_B_LOGIN = 'tenant-b-owner@probe.invalid';

/**
 * An Expo token already registered to tenant B's device — the "held" half of security-guide §2.2's
 * documented exception 2. `expo_push_token` is a GLOBAL UNIQUE, so tenant A registering this value
 * trips the constraint on a row RLS hides from it and the route fails closed at `403` (task 118).
 */
const TENANT_B_HELD_PUSH_TOKEN = 'ExponentPushToken[sec-tenant-04-held-by-b]';

/** A test password KDF: real shape, no argon2 cost. Only the login probe reaches it. */
const fastPasswordKdf = {
  createVerifier: (password: string) => Promise.resolve(`fake:${password}`),
  verify: (password: string, verifierJson: string) =>
    Promise.resolve(verifierJson === `fake:${password}`),
  runDummy: () => Promise.resolve(),
};

export interface TenantProbeFixture {
  /** Issue a request to the in-process app (no sockets). */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** The composed app, for `enumerateEndpoints` / `middlewareMounts`. */
  readonly app: { readonly routes: readonly { method: string; path: string }[] };
  readonly ctx: ProbeContext;
  /** Every access-log record the run emitted (SEC-SECRET-01 reads this too). */
  readonly accessLogs: string[];
  close(): Promise<void>;
}

/**
 * Boot the probe fixture. Two tenants, two stores in tenant A, one device per store, a control
 * session for tenant A, and three media rows covering the SEC-MEDIA-03 legs.
 */
export async function openTenantProbeFixture(): Promise<TenantProbeFixture> {
  const pglite = new PGlite();
  const db = new Kysely<DB>({
    dialect: new PGliteDialect({ pglite }),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });
  await migrateToLatest(db);

  const clock = new FakeClock(CLOCK_BASE);
  const accessLogs: string[] = [];
  const tokens = new InMemoryTokenStore();

  // Production-shaped tenant transaction: SET LOCAL ROLE bolusi_app (so FORCE RLS applies — the
  // owner-bypass trap) then the transaction-local tenant GUC.
  const forTenant = <T>(tenantId: string, fn: (tx: Kysely<DB>) => Promise<T>): Promise<T> =>
    db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE ${sql.id(APP_ROLE)}`.execute(trx);
      await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      return fn(trx);
    });

  // The SAME definer function production `findLoginCredential` calls (db-server auth-entry.ts) —
  // only the handle is this fixture's. The cross-tenant resolution logic stays in the migration.
  const authDirectory = {
    findDeviceByTokenHash: () => Promise.resolve(undefined),
    findControlSessionByTokenHash: () => Promise.resolve(undefined),
    findLoginCredential: async (loginIdentifier: string) => {
      const { rows } = await sql<{
        tenantId: string;
        userId: string;
        passwordVerifier: string | null;
        status: string;
      }>`
        SELECT tenant_id AS "tenantId", user_id AS "userId",
               password_verifier AS "passwordVerifier", status
          FROM auth_find_login_credential(${loginIdentifier})
      `.execute(db);
      return rows[0];
    },
  };

  const app = createApp({
    now: () => clock.now(),
    forTenant,
    verifyToken: createVerifyToken({ store: tokens, now: () => clock.now() }),
    authDirectory,
    passwordKdf: fastPasswordKdf,
    accessLogSink: (record: unknown) => accessLogs.push(JSON.stringify(record)),
  } as unknown as NonNullable<Parameters<typeof createApp>[0]>);

  // ── seed ──────────────────────────────────────────────────────────────────────────────────────
  const keyA1 = deriveDeviceKeypair(2804, 0);
  const keyA2 = deriveDeviceKeypair(2804, 1);
  const keyB = deriveDeviceKeypair(2804, 2);

  const seedTenant = async (tenantId: string, name: string): Promise<void> => {
    await sql`INSERT INTO tenants (id, name, created_at) VALUES (${tenantId}, ${name}, ${CREATED_AT})`.execute(
      db,
    );
    await sql`INSERT INTO tenant_op_counters (tenant_id, next_server_seq) VALUES (${tenantId}, ${1n})`.execute(
      db,
    );
  };
  const seedStore = (tenantId: string, storeId: string, name: string): Promise<unknown> =>
    sql`INSERT INTO stores (id, tenant_id, name, created_at) VALUES (${storeId}, ${tenantId}, ${name}, ${CREATED_AT})`.execute(
      db,
    );
  const seedUser = (
    tenantId: string,
    userId: string,
    storeId: string,
    login: string | null,
  ): Promise<unknown> =>
    sql`
      WITH u AS (
        INSERT INTO users (id, tenant_id, name, created_at, login_identifier, password_verifier)
        VALUES (${userId}, ${tenantId}, ${'probe-user'}, ${CREATED_AT}, ${login}, ${null})
      )
      INSERT INTO user_stores (user_id, store_id, tenant_id) VALUES (${userId}, ${storeId}, ${tenantId})
    `.execute(db);
  const seedDevice = (
    tenantId: string,
    deviceId: string,
    storeId: string,
    publicKeyBase64: string,
  ): Promise<unknown> =>
    sql`INSERT INTO devices (id, tenant_id, store_id, kind, signing_key_public, status, revoked_at, enrolled_at, last_seq, last_hash, last_sync_at)
        VALUES (${deviceId}, ${tenantId}, ${storeId}, ${'member'}, ${publicKeyBase64}, ${'active'}, ${null}, ${CREATED_AT}, ${0n}, ${null}, ${null})`.execute(
      db,
    );
  const seedMedia = (
    tenantId: string,
    mediaId: string,
    storeId: string,
    deviceId: string,
    userId: string,
    status: 'receiving' | 'complete',
  ): Promise<unknown> =>
    sql`INSERT INTO media (id, tenant_id, store_id, device_id, captured_by_user_id, type, mime_type, byte_size, sha256,
                           chunk_size, chunks_total, status, storage_key, captured_at, created_at)
        VALUES (${mediaId}, ${tenantId}, ${storeId}, ${deviceId}, ${userId}, ${'image'}, ${'image/jpeg'}, ${1024n},
                ${'0'.repeat(64)}, ${262144}, ${1}, ${status},
                ${status === 'complete' ? `t/${tenantId}/m/${mediaId}` : null}, ${CREATED_AT}, ${CREATED_AT})`.execute(
      db,
    );

  await seedTenant(ID.tenantA, 'tenant-a');
  await seedTenant(ID.tenantB, 'tenant-b');
  await seedStore(ID.tenantA, ID.storeA1, 'store-a1');
  await seedStore(ID.tenantA, ID.storeA2, 'store-a2');
  await seedStore(ID.tenantB, ID.storeB, 'store-b');
  await seedUser(ID.tenantA, ID.userA1, ID.storeA1, null);
  await seedUser(ID.tenantA, ID.userA2, ID.storeA2, null);
  await seedUser(ID.tenantB, ID.userB, ID.storeB, TENANT_B_LOGIN);
  await seedDevice(ID.tenantA, ID.deviceA1, ID.storeA1, bytesToBase64(keyA1.publicKey));
  await seedDevice(ID.tenantA, ID.deviceA2, ID.storeA2, bytesToBase64(keyA2.publicKey));
  await seedDevice(ID.tenantB, ID.deviceB, ID.storeB, bytesToBase64(keyB.publicKey));
  await seedMedia(ID.tenantA, ID.mediaA2, ID.storeA2, ID.deviceA2, ID.userA2, 'complete');
  await seedMedia(ID.tenantA, ID.mediaAOther, ID.storeA1, ID.deviceA2, ID.userA2, 'receiving');
  await seedMedia(ID.tenantB, ID.mediaB, ID.storeB, ID.deviceB, ID.userB, 'complete');
  await sql`INSERT INTO push_tokens (id, tenant_id, device_id, user_id, expo_push_token, platform, updated_at)
            VALUES (${ID.pushTokenB}, ${ID.tenantB}, ${ID.deviceB}, ${ID.userB}, ${TENANT_B_HELD_PUSH_TOKEN}, ${'android'}, ${CREATED_AT})`.execute(
    db,
  );

  const deviceToken = 'bdt_probe_tenant_a_device_1';
  const controlToken = 'bcs_probe_tenant_a_control';
  tokens.add(deviceToken, {
    kind: 'device',
    deviceId: ID.deviceA1,
    tenantId: ID.tenantA,
    storeId: ID.storeA1,
    deviceStatus: 'active',
  });
  tokens.add(controlToken, {
    kind: 'control',
    userId: ID.userA1,
    tenantId: ID.tenantA,
    expiresAt: CLOCK_BASE + 3_600_000,
  });

  const ctx: ProbeContext = {
    tenantAAuth: `Bearer ${deviceToken}`,
    tenantAControlAuth: `Bearer ${controlToken}`,
    tenantAUserId: ID.userA1,
    tenantADeviceId: ID.deviceA1,
    tenantADeviceSeed: keyA1.seed,
    tenantAStore1Id: ID.storeA1,
    tenantAStore2Id: ID.storeA2,
    tenantAStore2UserId: ID.userA2,
    tenantAStore2DeviceId: ID.deviceA2,
    tenantAStore2MediaId: ID.mediaA2,
    tenantAOtherDeviceMediaId: ID.mediaAOther,
    tenantBTenantId: ID.tenantB,
    tenantBUserId: ID.userB,
    tenantBDeviceId: ID.deviceB,
    tenantBStoreId: ID.storeB,
    tenantBMediaId: ID.mediaB,
    tenantBLoginIdentifier: TENANT_B_LOGIN,
    tenantBHeldPushToken: TENANT_B_HELD_PUSH_TOKEN,
    nonexistentId: ID.nonexistent,
  };

  return {
    request: (path, init) => Promise.resolve(app.request(`http://probe.test${path}`, init)),
    app: app as unknown as { routes: readonly { method: string; path: string }[] },
    ctx,
    accessLogs,
    close: () => db.destroy(),
  };
}
