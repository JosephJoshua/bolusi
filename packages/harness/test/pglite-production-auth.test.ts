// TASK 201 (Option B) DE-RISK / §2.5 adversarial evidence — the pivotal falsification that gates all
// downstream emulator-lane build work: does the REAL production auth path (the three D14
// `auth_find_*` SECURITY DEFINER functions, invoked by production `createDbVerifyToken` and
// `/v1/auth/login`) actually EXECUTE under PGlite (WASM Postgres)?
//
// WHY THIS TEST EXISTS. `HarnessServer.boot` today ALWAYS injects `verifyToken` (server.ts) — so the
// production DB-backed verifier path NEVER fires under PGlite in any existing suite. Chaos already
// proves `SET LOCAL ROLE bolusi_app` + RLS + projections + the enroll tx under PGlite; the SINGLE
// unproven residual for standing `@bolusi/server` up on the serverless emulator lane is SECURITY
// DEFINER semantics under PGlite. This test injects ONE PGlite-backed production `authDirectory` and
// OMITS `verifyToken`, so `resolveDeps` builds `createDbVerifyToken(authDirectory)` (deps.ts) —
// routing ALL THREE definers (login → findLoginCredential; enroll Bearer →
// findControlSessionByTokenHash; device token → findDeviceByTokenHash) through PGlite — then drives a
// REAL login → enroll. Green ⇒ Option B's server half is feasible. Red ⇒ SECURITY DEFINER is
// incompatible with PGlite WASM and the approach needs rework BEFORE any ci.yml / emulator-gates.sh
// change.
//
// BOUNDARY (T-7). `@bolusi/harness` (`private: true`) is the one workspace the boundary rule lets
// value-import `@bolusi/server` (test-support.ts header). `provisionTenant` is the REAL CLI code path
// (the same single transaction production provisioning runs), re-exported via
// `@bolusi/server/test-support` — not a bypass.
//
// FIDELITY (emulator-lane-hops discipline: verify each new hop against a faithful oracle). The PGlite
// `db` + `forTenant` + `authDirectory` mirror the proven `apps/server/test/helpers/identity-db.ts`
// oracle exactly, swapping only the driver PG16 → PGlite. Provision + password-verify + login-verify
// all use the same real argon2id: `defaultProvisionDeps.createPasswordVerifier` and the `resolveDeps`
// default `passwordKdf` are both `noblePasswordKdf`, so no KDF is injected on either side.
import { PGlite } from '@electric-sql/pglite';
import { CamelCasePlugin, Kysely, PGliteDialect, sql } from 'kysely';
import { afterEach, describe, expect, test } from 'vitest';

import {
  buildPinVerifier,
  bytesToBase64,
  createUuidV7Generator,
  DEFAULT_KDF_PARAMS,
  verifyPinAgainst,
  type CanonicalRef,
  type PinVerifier,
} from '@bolusi/core';
import { migrateToLatest, type DB } from '@bolusi/db-server';
import { createApp } from '@bolusi/server';
import {
  defaultProvisionDeps,
  provisionTenant,
  type ProvisionResult,
} from '@bolusi/server/test-support';
import { deriveDeviceKeypair, FakeClock, noblePort } from '@bolusi/test-support';

const CLOCK_BASE = 1_726_100_000_000;
const BASE = 'http://srv.test';

interface ProductionAuthServer {
  readonly app: ReturnType<typeof createApp>;
  readonly db: Kysely<DB>;
  readonly forTenant: <T>(tenantId: string, fn: (tx: Kysely<DB>) => Promise<T>) => Promise<T>;
  readonly clock: FakeClock;
  close(): Promise<void>;
}

/**
 * Boot production `createApp` over PGlite with the DB-backed production auth path ENGAGED: inject a
 * PGlite `authDirectory` (mirroring identity-db.ts) and OMIT `verifyToken` + `passwordKdf` so the real
 * `createDbVerifyToken` + `noblePasswordKdf` run. The whole overrides object crosses the package
 * boundary via one structural cast, exactly as server.ts does (the `ServerDeps` internals are not
 * exported by name, but the parameter type is structural).
 */
async function bootProductionAuth(): Promise<ProductionAuthServer> {
  const pglite = new PGlite();
  const db = new Kysely<DB>({
    dialect: new PGliteDialect({ pglite }),
    plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
  });
  await migrateToLatest(db);

  const clock = new FakeClock(CLOCK_BASE);

  // Production-shape forTenant: SET LOCAL ROLE bolusi_app + transaction-local set_config. The PGlite
  // `db` handle is a superuser (bypasses RLS under FORCE) — SET LOCAL ROLE is what engages RLS, so
  // this line is load-bearing, not cosmetic (identity-db.ts T-14b).
  const forTenant = <T>(tenantId: string, fn: (tx: Kysely<DB>) => Promise<T>): Promise<T> =>
    db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE bolusi_app`.execute(trx);
      await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      return fn(trx);
    });

  // The production D14 SECURITY DEFINER lookups, run over PGlite (mirrors identity-db.ts verbatim).
  const authDirectory = {
    async findDeviceByTokenHash(hashHex: string) {
      const { rows } = await sql<{
        tenantId: string;
        storeId: string | null;
        deviceId: string;
        status: string;
      }>`SELECT * FROM auth_find_device_by_token_hash(${hashHex})`.execute(db);
      return rows[0];
    },
    async findControlSessionByTokenHash(hashHex: string) {
      const { rows } = await sql<{
        tenantId: string;
        userId: string;
        sessionId: string;
        expiresAt: string | number;
        revokedAt: string | number | null;
      }>`SELECT * FROM auth_find_control_session_by_token_hash(${hashHex})`.execute(db);
      const row = rows[0];
      if (row === undefined) return undefined;
      return {
        tenantId: row.tenantId,
        userId: row.userId,
        sessionId: row.sessionId,
        expiresAt: Number(row.expiresAt),
        revokedAt: row.revokedAt === null ? null : Number(row.revokedAt),
      };
    },
    async findLoginCredential(loginIdentifier: string) {
      const { rows } = await sql<{
        tenantId: string;
        userId: string;
        passwordVerifier: string | null;
        status: string;
      }>`SELECT * FROM auth_find_login_credential(${loginIdentifier})`.execute(db);
      return rows[0];
    },
  };

  const app = createApp({
    now: () => clock.now(),
    forTenant,
    authDirectory,
    // verifyToken OMITTED → resolveDeps builds createDbVerifyToken(authDirectory) (deps.ts:378).
    // passwordKdf OMITTED → resolveDeps defaults to noblePasswordKdf (deps.ts:381), the same real
    //                       argon2id defaultProvisionDeps.createPasswordVerifier writes.
  } as unknown as NonNullable<Parameters<typeof createApp>[0]>);

  return { app, db, forTenant, clock, close: () => db.destroy() };
}

async function provisionOwner(s: ProductionAuthServer): Promise<ProvisionResult> {
  return provisionTenant(
    { ...defaultProvisionDeps, forTenant: s.forTenant, now: () => s.clock.now() },
    {
      tenantName: 'Gudang Selatan',
      storeNames: ['Toko Utama'],
      ownerName: 'Pemilik',
      ownerLogin: 'gudang-selatan',
    },
  );
}

async function login(s: ProductionAuthServer, oneTimePassword: string): Promise<Response> {
  return s.app.request(`${BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginIdentifier: 'gudang-selatan', password: oneTimePassword }),
  });
}

async function enroll(
  s: ProductionAuthServer,
  controlSession: string,
  storeId: string,
  deviceSeed: number,
): Promise<Response> {
  const ids = createUuidV7Generator({
    now: () => s.clock.now(),
    randomBytes: (n) => noblePort.randomBytes(n),
  });
  return s.app.request(`${BASE}/v1/devices/enroll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${controlSession}`,
      'Idempotency-Key': ids(),
    },
    body: JSON.stringify({
      deviceId: ids(),
      devicePublicKeyB64: bytesToBase64(deriveDeviceKeypair(deviceSeed, 0).publicKey),
      storeId,
      deviceName: 'Tablet Kasir',
      platform: 'android',
      appVersion: '1.0.0',
    }),
  });
}

describe('task 201-B de-risk: production auth (D14 SECURITY DEFINER) over PGlite', () => {
  let srv: ProductionAuthServer | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });

  test('real login → device enroll succeeds: all three auth_find_* definers execute under PGlite', async () => {
    srv = await bootProductionAuth();
    const p = await provisionOwner(srv);

    // (1) LOGIN — findLoginCredential (definer) + argon2id verify, over PGlite.
    const loginRes = await login(srv, p.oneTimePassword);
    expect(loginRes.status).toBe(200);
    const loginBody = (await loginRes.json()) as { controlSession?: unknown };
    expect(typeof loginBody.controlSession).toBe('string');

    // (2) ENROLL — the Bearer control session resolves via findControlSessionByTokenHash (definer).
    const enrollRes = await enroll(srv, loginBody.controlSession as string, p.storeIds[0], 1);
    expect(enrollRes.status).toBe(201);
    const enrollBody = (await enrollRes.json()) as {
      deviceToken?: unknown;
      bundle?: { store?: { id?: unknown } };
    };
    expect(typeof enrollBody.deviceToken).toBe('string');
    expect(enrollBody.bundle?.store?.id).toBe(p.storeIds[0]);
  });

  test('a server-seeded PIN verifier reaches the device via the enroll bundle and verifies', async () => {
    srv = await bootProductionAuth();
    const p = await provisionOwner(srv);

    // Seed the owner's PIN verifier with REAL argon2id — the exact row shape users.ts `writeVerifier`
    // writes (params jsonb as { m, t, p }). A self-describing verifier: its argon2id params travel
    // with it, so it verifies on-device iff both sides run standard argon2id.
    const correctPin = new TextEncoder().encode('271828');
    const salt = noblePort.randomBytes(16);
    const asOf: CanonicalRef = { timestamp: srv.clock.now(), deviceId: p.systemDeviceId, seq: 0 };
    const verifier = await buildPinVerifier(noblePort, correctPin, DEFAULT_KDF_PARAMS, salt, asOf);
    await srv.forTenant(p.tenantId, (trx) =>
      trx
        .insertInto('userPinVerifiers')
        .values({
          userId: p.ownerUserId,
          tenantId: p.tenantId,
          algo: 'argon2id',
          salt: verifier.saltB64,
          params: { m: verifier.mKiB, t: verifier.t, p: verifier.p } as never,
          hash: verifier.hashB64,
          asOfTimestamp: BigInt(verifier.asOf.timestamp),
          asOfDeviceId: verifier.asOf.deviceId,
          asOfSeq: BigInt(verifier.asOf.seq),
        })
        .execute(),
    );

    const loginRes = await login(srv, p.oneTimePassword);
    const controlSession = ((await loginRes.json()) as { controlSession: string }).controlSession;
    const enrollRes = await enroll(srv, controlSession, p.storeIds[0], 2);
    expect(enrollRes.status).toBe(201);
    const { bundle } = (await enrollRes.json()) as {
      bundle: { users: { id: string; pinVerifier: PinVerifier | null }[] };
    };

    const owner = bundle.users.find((u) => u.id === p.ownerUserId);
    expect(owner).toBeDefined();
    expect(owner?.pinVerifier).not.toBeNull();

    // The carried verifier accepts the correct PIN and rejects a wrong one, on the SAME argon2id.
    const carried = owner?.pinVerifier as PinVerifier;
    expect(await verifyPinAgainst(noblePort, carried, new TextEncoder().encode('271828'))).toBe(
      true,
    );
    expect(await verifyPinAgainst(noblePort, carried, new TextEncoder().encode('999999'))).toBe(
      false,
    );
  });
});
