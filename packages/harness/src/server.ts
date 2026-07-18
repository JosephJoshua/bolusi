// The harness server (testing-guide §3.1): the REAL production `@bolusi/server` (`createApp`, full
// middleware chain, the task-16 push/pull pipeline, the task-25 notes op registry + appliers) in
// process on PGlite, reached ONLY via `app.request` (no sockets). PGlite is a real Postgres (WASM),
// so the production migrations — roles, RLS FORCE, definer functions, the notes projection — run
// verbatim; the app's `forTenant` does `SET LOCAL ROLE bolusi_app` + `set_config('app.tenant_id')`
// exactly as production, so RLS is not vacuous (the owner-bypass trap, §2.5) even here.
//
// Only three deps are overridden — `forTenant` (the PGlite handle), `now` (the FakeClock), and
// `verifyToken` (a test token map). Everything else defaults: `opRegistry`/`projections` are derived
// from SERVER_MODULES, which registers notes (deps.ts), and the pokeHub/rate stores are in-memory.
// The harness owns NO protocol logic (T-7) — it wires production `createApp`.
import { PGlite } from '@electric-sql/pglite';
import { CamelCasePlugin, Kysely, PGliteDialect, sql } from 'kysely';

import { migrateToLatest, type DB } from '@bolusi/db-server';
import { createApp } from '@bolusi/server';
import { FakeClock } from '@bolusi/test-support';

import type { DeviceIdentity } from './device.js';
import type { FetchLike } from './fault-fetch.js';

const SERVER_CLOCK_BASE = 1_726_100_000_000;
const CREATED_AT = 1_726_000_000_000n;
const APP_ROLE = 'bolusi_app';

/** A device seeded into the server directory: its bearer header + identity. */
export interface SeededServerDevice {
  readonly identity: DeviceIdentity;
  readonly auth: string;
}

interface DevicePrincipal {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly storeId: string | null;
}

export class HarnessServer {
  readonly accessLogs: string[] = [];
  #tokenCounter = 0;

  private constructor(
    readonly db: Kysely<DB>,
    readonly clock: FakeClock,
    readonly fetch: FetchLike,
    private readonly tokens: Map<string, DevicePrincipal>,
  ) {}

  /** Boot the server: fresh PGlite, run the real migrations, wire `createApp`. */
  static async boot(): Promise<HarnessServer> {
    const pglite = new PGlite();
    const db = new Kysely<DB>({
      dialect: new PGliteDialect({ pglite }),
      plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
    });
    await migrateToLatest(db);

    const clock = new FakeClock(SERVER_CLOCK_BASE);
    const tokens = new Map<string, DevicePrincipal>();
    const accessLogs: string[] = [];

    // The RLS-scoped tenant transaction, exactly as production `dbForTenant` (helpers.ts shape):
    // SET LOCAL ROLE bolusi_app so the app is subject to the FORCE RLS predicate, then set_config
    // the tenant id (transaction-local — never leaks across the pooled connection).
    const forTenant = <T>(tenantId: string, fn: (tx: Kysely<DB>) => Promise<T>): Promise<T> =>
      db.transaction().execute(async (trx) => {
        await sql`SET LOCAL ROLE ${sql.id(APP_ROLE)}`.execute(trx);
        await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
        return fn(trx);
      });

    const verifyToken = async (
      token: string,
      c: { set: (k: 'device', v: DevicePrincipal) => void },
    ): Promise<void> => {
      const principal = tokens.get(token);
      if (principal === undefined) {
        throw new Error(`harness verifyToken: unknown token (${token.slice(0, 8)}…)`);
      }
      c.set('device', principal);
    };

    // The forTenant/verifyToken shapes are the production ones; the internal ServerDeps types are
    // not exported from @bolusi/server, so the whole overrides object crosses the boundary via one
    // structural cast (the harness test-only seam).
    const app = createApp({
      now: () => clock.now(),
      forTenant,
      verifyToken,
      accessLogSink: (record: unknown) => accessLogs.push(JSON.stringify(record)),
    } as unknown as NonNullable<Parameters<typeof createApp>[0]>);

    const server = new HarnessServer(
      db,
      clock,
      (input, init) => Promise.resolve(app.request(input, init)),
      tokens,
    );
    (server as { accessLogs: string[] }).accessLogs = accessLogs;
    return server;
  }

  /** Seed a device (tenant/store/user/device rows + directory pubkey) and issue its bearer token. */
  async seedDevice(
    identity: DeviceIdentity,
    options?: { status?: 'active' | 'revoked' },
  ): Promise<SeededServerDevice> {
    const status = options?.status ?? 'active';
    // Idempotent tenant/store seeding — many devices share one tenant + store (a run's topology).
    await sql`INSERT INTO tenants (id, name, created_at) VALUES (${identity.tenantId}, ${'harness'}, ${CREATED_AT})
              ON CONFLICT (id) DO NOTHING`.execute(this.db);
    await sql`INSERT INTO tenant_op_counters (tenant_id, next_server_seq) VALUES (${identity.tenantId}, ${1n})
              ON CONFLICT (tenant_id) DO NOTHING`.execute(this.db);
    await sql`INSERT INTO stores (id, tenant_id, name, created_at) VALUES (${identity.storeId}, ${identity.tenantId}, ${'store'}, ${CREATED_AT})
              ON CONFLICT (id) DO NOTHING`.execute(this.db);
    await sql`INSERT INTO users (id, tenant_id, name, created_at) VALUES (${identity.userId}, ${identity.tenantId}, ${'user'}, ${CREATED_AT})
              ON CONFLICT (id) DO NOTHING`.execute(this.db);
    await sql`INSERT INTO devices (id, tenant_id, store_id, kind, signing_key_public, status, revoked_at, enrolled_at, last_seq, last_hash, last_sync_at)
              VALUES (${identity.deviceId}, ${identity.tenantId}, ${identity.storeId}, ${'member'}, ${identity.publicKeyBase64}, ${status},
                      ${status === 'revoked' ? CREATED_AT : null}, ${CREATED_AT}, ${0n}, ${null}, ${null})
              ON CONFLICT (id) DO NOTHING`.execute(this.db);

    this.#tokenCounter += 1;
    const token = `bdt_harness_${this.#tokenCounter.toString(16).padStart(8, '0')}`;
    this.tokens.set(token, {
      deviceId: identity.deviceId,
      tenantId: identity.tenantId,
      storeId: identity.storeId,
    });
    return { identity, auth: `Bearer ${token}` };
  }

  async close(): Promise<void> {
    // Destroying the Kysely handle closes the PGlite instance the dialect owns; closing it again
    // throws "PGlite is closed", so the single destroy is the whole teardown.
    await this.db.destroy();
  }
}
