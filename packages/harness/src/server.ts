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

/**
 * A signer over a tenant's system-device Ed25519 key — mirrors the server's `SystemSigner`
 * (oplog/system-op.ts). Mirrored (not imported) because `@bolusi/server` does not export its
 * internal signer/key-store types; the whole overrides object crosses the boundary structurally.
 */
export type HarnessSystemSigner = (hash: Uint8Array) => Uint8Array;

/**
 * The deployment-owned system-key source `createApp` reads STRUCTURALLY (01 §3.6; conflict-wiring.ts
 * `SystemKeyStore`). Its PRESENCE is what enables the REAL conflict-detection pipeline: `resolveDeps`
 * builds `detectConflicts` from `SERVER_MODULES` over this store (deps.ts). The harness forks NO
 * detection (T-7) — it hands the production composition root a key source and lets it wire the rest.
 */
export interface HarnessSystemKeyStore {
  getSystemSigner(
    tenantId: string,
  ): HarnessSystemSigner | undefined | Promise<HarnessSystemSigner | undefined>;
}

/** The post-commit surfaced-conflict record the pipeline fires (03 §7; conflict-detection.ts). */
export interface HarnessSurfacedConflict {
  readonly conflictId: string;
  readonly tenantId: string;
  readonly storeId: string | null;
  readonly category: 'conflict';
}

/** A tenant's system actor + device (01 §3.6): the actor for `platform.conflict_detected` only. */
export interface SystemDeviceSeed {
  readonly tenantId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly publicKeyBase64: string;
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

  /**
   * Boot the server: fresh PGlite, run the real migrations, wire `createApp`.
   *
   * `gzipOnProgress` is the production decompression-witness seam (deps.ts `gzipOnProgress`,
   * gzip-decompress.ts `onProgress`): CHAOS-10 passes it to read the cumulative decompressed-byte
   * count and prove the gzip-bomb defense aborts at the cap (bounded memory — the stream is never
   * fully expanded) and that a wire-cap rejection never invokes decompression at all.
   */
  static async boot(options?: {
    readonly gzipOnProgress?: (decompressedBytesSoFar: number) => void;
    /**
     * CHAOS-07 (testing-guide §3.6): enables the REAL server conflict-detection pipeline. When
     * present, production `resolveDeps` builds `detectConflicts` from `SERVER_MODULES` over this
     * store and threads it through the push route (deps.ts) — the harness detects nothing itself.
     * Requires the tenant's system device seeded (`seedSystemDevice`) so the signer's pubkey matches
     * `devices.signing_key_public` (appendSystemOp self-verifies, 05 §2.2).
     */
    readonly systemKeyStore?: HarnessSystemKeyStore;
    /** CHAOS-07: the post-commit hook the pipeline fires for SIGNIFICANT conflicts only (03 §7). */
    readonly onConflictSurfaced?: (conflict: HarnessSurfacedConflict) => Promise<void>;
  }): Promise<HarnessServer> {
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
      ...(options?.gzipOnProgress === undefined ? {} : { gzipOnProgress: options.gzipOnProgress }),
      // CHAOS-07: forwarded structurally to production `resolveDeps` (deps.ts). `systemKeyStore`
      // is the enable-switch — with it, `detectConflicts` is built from SERVER_MODULES; without it,
      // detection stays undefined and pushes proceed unchecked (the honest v0 default).
      ...(options?.systemKeyStore === undefined ? {} : { systemKeyStore: options.systemKeyStore }),
      ...(options?.onConflictSurfaced === undefined
        ? {}
        : { onConflictSurfaced: options.onConflictSurfaced }),
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

  /**
   * Seed the tenant's system actor + device + chain state (01 §3.6, 10-db §12) — the identity the
   * conflict-detection pipeline emits `platform.conflict_detected` through. Exactly one per tenant:
   * a `users` row flagged `is_system` (loadSystemDirectory reads it by that flag), a `devices` row
   * `kind='system'` with a NULL store, and the genesis `system_device_chain_state` row (last_seq 0,
   * last_hash NULL). `publicKeyBase64` MUST match the key the boot `systemKeyStore` signs with, or
   * `appendSystemOp`'s self-verify (05 §2.2) fails the first detected conflict loudly.
   *
   * No bearer token: the system device never pushes over HTTP — its ops are built server-side inside
   * the push transaction. The tenant/counter are seeded idempotently so ordering vs `seedDevice` is
   * free.
   */
  async seedSystemDevice(seed: SystemDeviceSeed): Promise<void> {
    await sql`INSERT INTO tenants (id, name, created_at) VALUES (${seed.tenantId}, ${'harness'}, ${CREATED_AT})
              ON CONFLICT (id) DO NOTHING`.execute(this.db);
    await sql`INSERT INTO tenant_op_counters (tenant_id, next_server_seq) VALUES (${seed.tenantId}, ${1n})
              ON CONFLICT (tenant_id) DO NOTHING`.execute(this.db);
    await sql`INSERT INTO users (id, tenant_id, name, created_at, is_system)
              VALUES (${seed.userId}, ${seed.tenantId}, ${'system'}, ${CREATED_AT}, ${true})
              ON CONFLICT (id) DO NOTHING`.execute(this.db);
    await sql`INSERT INTO devices (id, tenant_id, store_id, kind, signing_key_public, status, revoked_at, enrolled_at, last_seq, last_hash, last_sync_at)
              VALUES (${seed.deviceId}, ${seed.tenantId}, ${null}, ${'system'}, ${seed.publicKeyBase64}, ${'active'},
                      ${null}, ${CREATED_AT}, ${0n}, ${null}, ${null})
              ON CONFLICT (id) DO NOTHING`.execute(this.db);
    await sql`INSERT INTO system_device_chain_state (tenant_id, device_id, last_seq, last_hash)
              VALUES (${seed.tenantId}, ${seed.deviceId}, ${0n}, ${null})
              ON CONFLICT (tenant_id) DO NOTHING`.execute(this.db);
  }

  async close(): Promise<void> {
    // Destroying the Kysely handle closes the PGlite instance the dialect owns; closing it again
    // throws "PGlite is closed", so the single destroy is the whole teardown.
    await this.db.destroy();
  }
}
