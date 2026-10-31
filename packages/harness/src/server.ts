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
import type { AddressInfo } from 'node:net';

import { PGlite } from '@electric-sql/pglite';
import type { ServerType } from '@hono/node-server';
import { CamelCasePlugin, Kysely, PGliteDialect, sql } from 'kysely';

import {
  migrateToLatest,
  readPhoneModelPhotoFrom,
  readPhoneModelsFrom,
  type DB,
  type TenantDb,
} from '@bolusi/db-server';
import { createApp, serveWithRealtime } from '@bolusi/server';
import { createVerifyToken, InMemoryTokenStore } from '@bolusi/server/test-support';
import { FakeClock } from '@bolusi/test-support';
import { OWNER_POWER_PERMISSIONS } from '@bolusi/core';

import type { DeviceIdentity } from './device.js';
import type { FetchLike } from './fault-fetch.js';
import { createPgliteAuthDirectory } from './production-auth.js';
import { assertLaneLoopbackBind } from './serve-lane.js';

const SERVER_CLOCK_BASE = 1_726_100_000_000;

/**
 * Real time, for a server a real app talks to. A phone stamps its changes with its own wall clock,
 * and the push refuses one dated more than 10 minutes ahead of the server (CLOCK_AHEAD), so the
 * scenarios' fixed 2024 clock would refuse every change the app makes. `set`/`advance` still work:
 * they shift the clock and it keeps running from there.
 */
class WallClock extends FakeClock {
  #offset = 0;

  override now(): number {
    return Date.now() + this.#offset;
  }

  override advance(ms: number): void {
    if (ms < 0) throw new RangeError(`WallClock.advance moves time forward only (got ${ms})`);
    this.#offset += ms;
  }

  override set(ms: number): void {
    this.#offset = ms - Date.now();
  }
}
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

/**
 * The harness's RLS-scoped tenant transaction (`SET LOCAL ROLE bolusi_app` + `set_config` the tenant),
 * production `dbForTenant`'s shape over the PGlite handle. Exposed on {@link HarnessServer} so the
 * production-auth emulator entry (task 201-B) can run the real `provisionTenant` transaction and seed a
 * PIN verifier through the SAME tenant-scoped path the app itself uses — never a raw, unscoped handle.
 */
// The callback receives a `TenantDb` (= `Transaction<DB>`), exactly what production `dbForTenant` hands
// and what `provisionTenant`'s `ForTenant` demands — never the wider raw `Kysely<DB>`. The concrete
// `forTenant` below is `db.transaction().execute(...)`, so the value IS always a transaction; typing it
// as such lets the real `provisionTenant` run through this path with no boundary cast.
export type HarnessForTenant = <T>(
  tenantId: string,
  fn: (tx: TenantDb) => Promise<T>,
) => Promise<T>;

/**
 * A {@link HarnessServer} exposed over a REAL loopback TCP socket (task 198 step 1). `url` is the
 * bound origin (`http://127.0.0.1:<ephemeral-port>` by default); `server` is the same booted instance,
 * so a test can still `seedDevice` after listening. `close()` shuts the socket AND destroys the PGlite
 * handle — call it once, in a `finally`.
 */
export interface RunningHarnessServer {
  readonly url: string;
  readonly address: string;
  readonly port: number;
  readonly server: HarnessServer;
  close(): Promise<void>;
}

/** Bracket an IPv6 host for a URL authority (`::1` → `[::1]`); pass IPv4/hostnames through. */
function formatHost(address: string): string {
  return address.includes(':') ? `[${address}]` : address;
}

/**
 * Runs push deliveries off the request path as production does, and remembers them so `close()` can
 * wait: destroying PGlite under an in-flight delivery wedges it, which turned a failed assertion
 * into a hang instead of a report.
 */
class TrackedDeliveries {
  readonly #pending = new Set<Promise<void>>();

  dispatch(task: () => Promise<void>): void {
    let started: Promise<void>;
    try {
      started = task();
    } catch {
      return;
    }
    const tracked = started.catch(() => undefined);
    this.#pending.add(tracked);
    void tracked.finally(() => this.#pending.delete(tracked));
  }

  async flush(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
  }
}

export class HarnessServer {
  readonly accessLogs: string[] = [];
  #deliveries: TrackedDeliveries | undefined;
  #tokenCounter = 0;

  private constructor(
    readonly db: Kysely<DB>,
    readonly clock: FakeClock,
    readonly fetch: FetchLike,
    /**
     * The RLS-scoped tenant transaction this server booted with (`SET LOCAL ROLE bolusi_app` +
     * `set_config`). Retained so the production-auth emulator entry can `provisionTenant` and seed a
     * PIN verifier through the same tenant-scoped path — the app never gets a raw, unscoped handle.
     */
    readonly forTenant: HarnessForTenant,
    private readonly tokens: Map<string, DevicePrincipal>,
    /**
     * CHAOS-05 (task 103 seam): when the server was booted with `testAuthSeam`, this is the REAL
     * `@bolusi/server/test-support` `InMemoryTokenStore` the production `createVerifyToken` reads.
     * `seedDevice` registers each device token here with its `deviceStatus`, so a `revoked` device
     * presenting its bearer gets the genuine `401 DEVICE_REVOKED` from the production `onError`
     * path (05 §8, api/01 §2) — the harness forges no 401 (T-7). `undefined` on every other boot.
     */
    private readonly authStore: InMemoryTokenStore | undefined,
    /**
     * The production Hono app this server wraps — retained so {@link listen} can serve its `app.fetch`
     * over a REAL socket (task 198). The in-process `fetch` above is `app.request` (path-routed); the
     * socket serves the SAME `app.fetch` production `main.ts` serves, so there is exactly one handler
     * and one protocol (T-7), reached two ways.
     */
    private readonly app: ReturnType<typeof createApp>,
    /**
     * Whether this server booted the §2.5 production-auth path (it mints REAL control-session + device
     * tokens, not just test `bdt_harness_*` bearers). When true, {@link listen} refuses any non-loopback
     * bind BY CONSTRUCTION — the token-minting surface cannot be talked onto the LAN by a caller that
     * forgets the guard (§2.11: a guard belongs at the bind site, not in a comment or a caller check).
     */
    private readonly productionAuth: boolean,
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
    /**
     * CHAOS-05 (testing-guide §3.6 / task 103): boot with the PRODUCTION test-auth verifier
     * (`createVerifyToken` over an `InMemoryTokenStore`, both from `@bolusi/server/test-support`)
     * instead of the default harness token map. Its only difference is REAL revocation semantics:
     * a device seeded `revoked` authenticates to the genuine `ApiError('DEVICE_REVOKED')` the real
     * `onError` renders as `401` — the seam injects a verdict's INPUT (a `deviceStatus` record),
     * never a bypass, so an active token still authenticates and an unknown token still
     * `AUTH_TOKEN_INVALID`s. Every other scenario leaves this unset and keeps the map verifier.
     */
    readonly testAuthSeam?: boolean;
    /**
     * Task 201-B (§2.5 security surface): boot the REAL DB-backed production auth path over PGlite —
     * inject `authDirectory` (the D14 `auth_find_*` definer lookups; {@link createPgliteAuthDirectory})
     * and OMIT `verifyToken`, so production `resolveDeps` builds `createDbVerifyToken(authDirectory)`
     * (deps.ts) and `POST /v1/auth/login` resolves credentials through `findLoginCredential`. This is
     * how the serverless emulator lane reaches an ENROLLED, unlocked app: a real login → device enroll,
     * verified end-to-end, no token-map bypass. Mutually exclusive with `testAuthSeam` (both own the
     * auth path). The default (both unset) keeps the in-memory token map.
     */
    readonly productionAuth?: boolean;
    /**
     * Run the server on real time instead of the scenarios' fixed FakeClock. For the lane a real app
     * syncs with (`harness-serve-lane.mjs`): the app's changes carry its wall clock.
     */
    readonly wallClock?: boolean;
  }): Promise<HarnessServer> {
    if (options?.productionAuth === true && options.testAuthSeam === true) {
      throw new Error(
        'HarnessServer.boot: productionAuth and testAuthSeam are mutually exclusive auth modes',
      );
    }
    const productionAuth = options?.productionAuth === true;
    const pglite = new PGlite();
    const db = new Kysely<DB>({
      dialect: new PGliteDialect({ pglite }),
      plugins: [new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true })],
    });
    await migrateToLatest(db);

    const clock = options?.wallClock === true ? new WallClock() : new FakeClock(SERVER_CLOCK_BASE);
    const tokens = new Map<string, DevicePrincipal>();
    // CHAOS-05: when the test-auth seam is on, the REAL production verifier reads this store; the
    // token MAP below is left unused (harmless). Off by default → the map verifier serves everyone.
    const authStore = options?.testAuthSeam === true ? new InMemoryTokenStore() : undefined;
    const accessLogs: string[] = [];

    // The RLS-scoped tenant transaction, exactly as production `dbForTenant` (helpers.ts shape):
    // SET LOCAL ROLE bolusi_app so the app is subject to the FORCE RLS predicate, then set_config
    // the tenant id (transaction-local — never leaks across the pooled connection).
    const forTenant = <T>(tenantId: string, fn: (tx: TenantDb) => Promise<T>): Promise<T> =>
      db.transaction().execute(async (trx) => {
        await sql`SET LOCAL ROLE ${sql.id(APP_ROLE)}`.execute(trx);
        await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
        return fn(trx);
      });

    // The map verifier (default): accepts any seeded token. NOT used when `testAuthSeam` is on —
    // there the production `createVerifyToken` runs instead, so the exact revoked→401 / unknown→
    // AUTH_TOKEN_INVALID verdicts come from the server, never from this closure.
    const mapVerifyToken = async (
      token: string,
      c: { set: (k: 'device', v: DevicePrincipal) => void },
    ): Promise<void> => {
      const principal = tokens.get(token);
      if (principal === undefined) {
        throw new Error(`harness verifyToken: unknown token (${token.slice(0, 8)}…)`);
      }
      c.set('device', principal);
    };
    const verifyToken =
      authStore === undefined
        ? mapVerifyToken
        : createVerifyToken({ store: authStore, now: () => clock.now() });

    // The forTenant/verifyToken/authDirectory shapes are the production ones; the internal ServerDeps
    // types are not exported from @bolusi/server, so the whole overrides object crosses the boundary
    // via one structural cast (the harness test-only seam).
    //
    // productionAuth ⇒ inject `authDirectory` (the PGlite D14 lookups) and OMIT `verifyToken`, so
    // `resolveDeps` builds the REAL `createDbVerifyToken(authDirectory)` (deps.ts:378) — every token
    // verify + login runs the production definer path. Otherwise inject the token-map/test-auth
    // `verifyToken` and let `authDirectory` default to `dbAuthDirectory` (unused: no request presents a
    // bdt_/bcs_ token the DB path would resolve, since the map verifier answers first).
    const deliveries = new TrackedDeliveries();
    const app = createApp({
      now: () => clock.now(),
      forTenant,
      deliveryDispatcher: deliveries,
      ...(productionAuth ? { authDirectory: createPgliteAuthDirectory(db) } : { verifyToken }),
      accessLogSink: (record: unknown) => accessLogs.push(JSON.stringify(record)),
      // The catalog is global data on the plain pool in production; here it is this PGlite's.
      phoneCatalog: {
        models: (after: number, limit: number) => readPhoneModelsFrom(db, after, limit),
        photo: (modelId: number) => readPhoneModelPhotoFrom(db, modelId),
      },
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
      forTenant,
      tokens,
      authStore,
      app,
      productionAuth,
    );
    (server as { accessLogs: string[] }).accessLogs = accessLogs;
    server.#deliveries = deliveries;
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
    await sql`INSERT INTO user_stores (user_id, store_id, tenant_id) VALUES (${identity.userId}, ${identity.storeId}, ${identity.tenantId})
              ON CONFLICT DO NOTHING`.execute(this.db);
    // The server authorizes every pushed op against the author's roles, so the seeded user holds a
    // tenant-wide role with every registered permission: the server-side twin of the devices'
    // grant-all evaluator (buildGrantAllEvaluator). Scenarios test sync, not role design.
    await sql`INSERT INTO roles (id, tenant_id, name, scope_type, created_at)
              VALUES (md5(${identity.tenantId} || ':harness-all')::uuid, ${identity.tenantId}, ${'harness_all'}, ${'tenant'}, ${CREATED_AT})
              ON CONFLICT (id) DO NOTHING`.execute(this.db);
    await sql`INSERT INTO role_permissions (role_id, permission_id, tenant_id)
              SELECT md5(${identity.tenantId} || ':harness-all')::uuid, id, ${identity.tenantId} FROM permissions
              ON CONFLICT DO NOTHING`.execute(this.db);
    await sql`INSERT INTO user_roles (tenant_id, user_id, role_id, store_id)
              SELECT ${identity.tenantId}, ${identity.userId}, md5(${identity.tenantId} || ':harness-all')::uuid, NULL
              WHERE NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id = ${identity.userId}
                                AND role_id = md5(${identity.tenantId} || ':harness-all')::uuid)`.execute(
      this.db,
    );
    // A staff role with every permission but the owner powers, granted to no one, as provisioning
    // seeds the preset staff roles: shared devices are sent what staff roles may read.
    await sql`INSERT INTO roles (id, tenant_id, name, scope_type, created_at)
              VALUES (md5(${identity.tenantId} || ':harness-staff')::uuid, ${identity.tenantId}, ${'harness_staff'}, ${'store'}, ${CREATED_AT})
              ON CONFLICT (id) DO NOTHING`.execute(this.db);
    await sql`INSERT INTO role_permissions (role_id, permission_id, tenant_id)
              SELECT md5(${identity.tenantId} || ':harness-staff')::uuid, id, ${identity.tenantId} FROM permissions
              WHERE id NOT IN (${sql.join(OWNER_POWER_PERMISSIONS)})
              ON CONFLICT DO NOTHING`.execute(this.db);
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
    // CHAOS-05: register the SAME plaintext token in the production test-auth store (keyed at rest
    // by its SHA-256), carrying the device's real `deviceStatus`. A `revoked` record makes
    // `createVerifyToken` throw the genuine `DEVICE_REVOKED` (05 §8); an `active` one authenticates
    // normally — so the seam can only inject a REAL verdict's input, never skip auth.
    this.authStore?.add(token, {
      kind: 'device',
      deviceId: identity.deviceId,
      tenantId: identity.tenantId,
      storeId: identity.storeId,
      deviceStatus: status,
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

  /**
   * Open a REAL `@hono/node-server` TCP socket serving this booted app's `app.fetch` (task 198 step 1)
   * so an on-device CHAOS runner (CHAOS-03/06/07) drives the production sync pipeline over the network,
   * not just in-process. The harness adds NO protocol (T-7) — it serves the SAME handler `main.ts`
   * does; it only opens a port.
   *
   * Binds host LOOPBACK ONLY (`127.0.0.1`) by default: this server mints valid `bdt_harness_*` bearer
   * tokens (and, under `productionAuth`, REAL control-session + device tokens), so it MUST NOT listen
   * on the LAN (§2.5). Under `productionAuth` this is CLOSED BY CONSTRUCTION, not merely defaulted: a
   * non-loopback `hostname` is refused here at the bind site ({@link assertLaneLoopbackBind}) BEFORE the
   * socket opens, so the token-minting surface cannot be talked onto the LAN by a caller that forgets
   * the guard (§2.11). The Android emulator still reaches it — `10.0.2.2` aliases the host loopback,
   * and `adb reverse tcp:P tcp:P` maps device `127.0.0.1:P` to the host — so loopback is both
   * sufficient and safe. `port` defaults to `0` ⇒ an ephemeral port, so parallel test servers never
   * collide; the emulator lane passes a FIXED port (`3000`, matching the APK's `EXPO_PUBLIC_API_URL`).
   */
  async listen(options?: {
    readonly hostname?: string;
    readonly port?: number;
  }): Promise<RunningHarnessServer> {
    const hostname = options?.hostname ?? '127.0.0.1';
    const port = options?.port ?? 0;
    // §2.5 closed-by-construction: a production-auth server mints REAL control-session + device tokens,
    // so refuse any non-loopback bind HERE, at the bind site, before the socket opens — no caller
    // (present or future) can open this token-minting surface to the LAN. Same pure, unit-falsifiable
    // predicate the serve entry uses (§2.8 one source): it accepts only `127.0.0.1` (not `::1`/`localhost`,
    // which are off the IPv4 `adb reverse` path this lane requires). Non-productionAuth binds are
    // unaffected — they still default to loopback but keep the CHAOS runners' existing flexibility.
    if (this.productionAuth) {
      assertLaneLoopbackBind(hostname);
    }
    const { node, info } = await new Promise<{ node: ServerType; info: AddressInfo }>((resolve) => {
      const node_ = serveWithRealtime({ fetch: this.app.fetch, hostname, port }, (i) =>
        resolve({ node: node_, info: i }),
      );
    });
    const url = `http://${formatHost(info.address)}:${info.port}`;
    return {
      url,
      address: info.address,
      port: info.port,
      server: this,
      close: async () => {
        // Drop keep-alive sockets first so `close()` (which waits for idle) resolves promptly instead
        // of hanging the vitest worker on a lingering undici keep-alive connection; then destroy
        // PGlite. `closeAllConnections` is a `net.Server` runtime method that `@types/node` declares
        // only on the http arm of `ServerType` (not the http2 arms we never create), so reach it
        // through an optional cast rather than widening the type.
        (node as { closeAllConnections?: () => void }).closeAllConnections?.();
        await new Promise<void>((resolve, reject) => {
          node.close((err) => (err === undefined || err === null ? resolve() : reject(err)));
        });
        await this.close();
      },
    };
  }

  /**
   * QA: make the server forget every enrolled phone's token, keeping the tenant, its staff and every
   * accepted change. Each phone's next request then gets 401 `AUTH_TOKEN_INVALID`, as after a server
   * restore that lost the device, so the "HP ini perlu didaftarkan ulang" flow can be tried on a
   * device. Returns the ids of the phones forgotten.
   */
  async forgetDeviceTokens(): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`
      UPDATE devices SET token_hash = NULL
      WHERE token_hash IS NOT NULL AND status <> 'revoked'
      RETURNING id
    `.execute(this.db);
    return rows.map((row) => row.id);
  }

  async close(): Promise<void> {
    await this.#deliveries?.flush();
    // Destroying the Kysely handle closes the PGlite instance the dialect owns; closing it again
    // throws "PGlite is closed", so the single destroy is the whole teardown.
    await this.db.destroy();
  }
}

/**
 * Boot a {@link HarnessServer} and immediately {@link HarnessServer.listen | listen} on a loopback
 * socket (task 198). The convenience entry the device CHAOS runners and the host adversarial tests
 * use: `const running = await startHarnessServer(); …; await running.close()`. Forwards every `boot`
 * option (e.g. `testAuthSeam`) plus an optional `hostname` override.
 */
export async function startHarnessServer(
  options?: NonNullable<Parameters<typeof HarnessServer.boot>[0]> & {
    readonly hostname?: string;
    readonly port?: number;
  },
): Promise<RunningHarnessServer> {
  const { hostname, port, ...bootOptions } = options ?? {};
  const server = await HarnessServer.boot(bootOptions);
  return server.listen({
    ...(hostname === undefined ? {} : { hostname }),
    ...(port === undefined ? {} : { port }),
  });
}
