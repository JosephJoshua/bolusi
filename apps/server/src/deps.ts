// Composition dependencies for the Hono app. Everything the middleware chain and stub routers
// touch that is an I/O boundary or a not-yet-built collaborator is injected here — so tests swap
// fakes (rate-limit stores, token verifier, forTenant, clock) and later tasks (13/16/…) drop in
// real implementations without reshaping the skeleton.
import { forTenant as dbForTenant, type DB, type ForTenant } from '@bolusi/db-server';
import {
  payloadSchemaFor,
  registerModules,
  type AnyModuleDefinition,
  type CryptoPort,
  type ModuleRegistry,
  type OperationDeclaration,
  type ProjectionRegistry,
} from '@bolusi/core';
import { ALL_MODULES } from '@bolusi/modules';
import type { Context } from 'hono';

import { dbAuthDirectory, type AuthDirectory } from './auth/directory.js';
import { createDbVerifyToken } from './auth/verify-token.js';
import { noblePasswordKdf, type PasswordKdf } from './crypto/index.js';
import type { AppEnv } from './env.js';
import { InMemoryWindowLimitStore, type WindowLimitStore } from './identity/rate-limits.js';
import { RevocationHooks } from './identity/revocation.js';
import { consoleAccessLogSink, type AccessLogSink } from './middleware/access-log.js';
import { type VerifyToken } from './middleware/auth.js';
import {
  InMemoryRateLimitStore,
  type DeviceRateLimits,
  type RateLimitStore,
} from './middleware/rate-limit.js';
import { isFoldableSchemaVersion, serverCryptoPort, type OpRegistry } from './oplog/index.js';
import {
  InMemorySyncCoalescer,
  sendConflictSurfaced,
  sendDeviceAlert,
  type PushDeliveryDeps,
} from './push/fanout.js';
import { ImmediateDeliveryDispatcher, type DeliveryDispatcher } from './push/dispatcher.js';
import { unconfiguredPushPort, type PushPort } from './push/port.js';
import { timerReceiptScheduler } from './push/receipts.js';
import { nodeHubScheduler, RealtimeHub, type HubScheduler } from './realtime/hub.js';
import { InProcessPokeHub, type PokeHub } from './realtime/poke-hub.js';
import type { SurfacedConflict } from './sync/conflict-detection.js';
import {
  buildConflictDetection,
  type DetectConflictsFn,
  type SystemKeyStore,
} from './sync/conflict-wiring.js';
import { uuidv7 } from './uuidv7.js';

/** Body-size caps by route class (api/00 §5.3). */
export const SYNC_PUSH_PATH = '/v1/sync/push';
export const WIRE_CAP_DEFAULT = 256 * 1024; // 256 KiB
export const DECOMPRESSED_CAP_DEFAULT = 1024 * 1024; // 1 MiB
export const WIRE_CAP_SYNC_PUSH = 1024 * 1024; // 1 MiB
export const DECOMPRESSED_CAP_SYNC_PUSH = 10 * 1024 * 1024; // 10 MiB

export interface BodyCaps {
  readonly wireBytes: number;
  readonly decompressedBytes: number;
}

export function defaultBodyCaps(path: string): BodyCaps {
  return path === SYNC_PUSH_PATH
    ? { wireBytes: WIRE_CAP_SYNC_PUSH, decompressedBytes: DECOMPRESSED_CAP_SYNC_PUSH }
    : { wireBytes: WIRE_CAP_DEFAULT, decompressedBytes: DECOMPRESSED_CAP_DEFAULT };
}

/** Default per-device caps (api/00 §11). */
export const DEFAULT_DEVICE_RATE_LIMITS: DeviceRateLimits = {
  perRoutePerMinute: 120,
  realtimePerMinute: 10,
  aggregatePerMinute: 600,
};

// PLACEHOLDER (flagged): api/00 §11 delegates the login per-IP numeric to api/02-auth — that
// number lands with task 13. Until then a conservative pre-auth cap protects the login route;
// it is a dep so task 13 sets the real value without touching the chain.
export const DEFAULT_LOGIN_IP_PER_MINUTE = 30;

/**
 * The server's module list — `@bolusi/modules`' single `ALL_MODULES`, re-cast to the server's
 * generated `DB`. Before task 90 this was a SECOND hand-maintained literal alongside the client's
 * `CLIENT_MODULES`, with nothing checking the two agreed (task 49 closed the same ring one level
 * down: 08 punted server embedding to "07/16", 16 to "17", 25 assumed "the registration list nobody
 * creates"). Task 90 unified them: both apps now register from ONE list, so a module is added — or
 * dropped — in exactly one place, and both apps' registration suites notice off the same edit
 * (CLAUDE.md §2.8).
 *
 * `registerModules(SERVER_MODULES)` turns it into BOTH the op-payload validators the push pipeline's
 * schema step consumes AND the projection appliers its apply step runs (10-db §3 step 6), so
 * validation and folding can never name different module sets. It carries `platform` (task 17) —
 * `conflicts` + `user_prefs`; `auth` (task 43) — `auth_sessions` + `pin_lockout_events` +
 * `auth_permission_denials`; `notes` (task 25) — the `notes` projection. That is all 6 of 6 server
 * projection tables folded; `platform`/`notes`/`auth-registration.test.ts` falsify each against the
 * real push path (removing a module from `ALL_MODULES` makes its ops `UNKNOWN_TYPE` and its tables
 * stay empty, §2.11).
 *
 * ON THE CAST. The appliers are typed against dialect-neutral `PlatformDatabase`/`AuthDatabase`/
 * `NotesDatabase` shapes (04 §2) — the one shape that runs on BOTH Postgres and SQLite, which is
 * what makes each one applier instead of two copies (§2.8). `DB` (db-server's generated schema) is
 * a different type: same columns, but `bigint` arrives as `Int8 = ColumnType<string, …>` and it
 * carries 30-odd tables the modules never name. Neither is assignable to the other, and
 * `apply(db: Kysely<DB>, …)` puts `DB` in a contravariant position, so no variance annotation
 * rescues it. `ALL_MODULES` already erased its element type to `AnyModuleDefinition<never>`; this
 * re-casts the whole list to the server's `DB`. The cast is where "one applier, two engines" is
 * paid for, and it is sound in exactly the way the T-8 conformance suite proves: the appliers touch
 * only the declared columns, through Kysely's dialect-neutral builder, and the suite folds them
 * against a real Postgres and a real SQLite and asserts byte-identical oracle digests.
 */
export const SERVER_MODULES: readonly AnyModuleDefinition<DB>[] =
  ALL_MODULES as unknown as readonly AnyModuleDefinition<DB>[];

const serverModuleRegistry: ModuleRegistry<DB> = registerModules(SERVER_MODULES);

/** Op type → declaring module's `OperationDeclaration`, flattened from SERVER_MODULES for the
 *  push pipeline's schema step (05 §8). One map, so a duplicate type would have thrown in
 *  `registerModules` before reaching here (04 §1). */
function deriveOpRegistry(registry: ModuleRegistry<DB>): OpRegistry {
  const byType = new Map<string, OperationDeclaration<DB>>();
  for (const module of registry.modules) {
    for (const [type, declaration] of Object.entries(module.operations)) {
      byType.set(type, declaration);
    }
  }
  return {
    resolve(type, schemaVersion) {
      const declaration = byType.get(type);
      if (declaration === undefined) return { kind: 'unknown' };

      const currentVersion = declaration.schemaVersion;
      // THE VERSION GATE (task 121; 05 §7/§8, schema-version.ts). The contract is
      // `resolve(type, schemaVersion)` and the schema step passes the claimed version; ignoring it —
      // as this did — accepted an op claiming ANY version whose payload happened to satisfy the
      // CURRENT schema, and the applier then threw at FOLD time on the durably-logged op. Consult the
      // registry's declared version (never a literal): a version the applier cannot fold (`> current`
      // or non-integer/`< 1`) has no registry schema for (`type`, `schemaVersion`), so it is a
      // SCHEMA_INVALID rejected HERE, at push, before any insert or fold (05 §8; the type is present,
      // so it is not UNKNOWN_TYPE).
      if (!isFoldableSchemaVersion(currentVersion, schemaVersion)) {
        return { kind: 'known', validate: () => false };
      }

      // THE PAYLOAD GATE (task 127; 05 §8, 04 §3). The version is foldable, so validate the payload
      // against the schema THAT VERSION declared — `payloadSchemaFor` returns `payload` for the
      // current version and the retained `payloadByVersion[v]` for a superseded one.
      //
      // This branch used to read `if (schemaVersion !== currentVersion) return { validate: () =>
      // true }`, and the comment justifying it was half right: re-validating an old payload against
      // the CURRENT schema really would reject a legitimate rolling-out client (a v2 `note_created`
      // carries `mediaId`, which v3's `.strict()` refuses). What it missed is that "no schema" is
      // not the only alternative to "the wrong schema". Skipping validation accepted ANY payload at
      // any version below current — `notes.note_created` is at v3, so v1 and v2 were a blanket
      // bypass — and the op then entered the signed, append-only log and threw inside the APPLIER,
      // where an exception propagates out of `forTenant` and rolls back the entire batch as a `500`.
      // That poisons honest sibling ops (security-guide §4.1) and wedges the pushing device: the
      // client reads a 500 as a transport failure, keeps the ops local, and re-sends the identical
      // batch forever. Retained per-version schemas (04 §3) are the answer that is neither too tight
      // nor open, and they are what 05 §8's "registry Zod for (`type`, `schemaVersion`)" already
      // presumed existed.
      const schema = payloadSchemaFor(declaration, schemaVersion);
      // FAIL CLOSED. `defineModule` makes retention complete for a registered module, so this is
      // unreachable in production — which is exactly why it must not be an `accept` (§2.11: a guard
      // whose failure mode is "silently permits" converts an unknown risk into a false assurance).
      // A version with no retained schema is a version nothing can validate; it is rejected.
      if (schema === undefined) {
        return { kind: 'known', validate: () => false };
      }

      // A parse throw is a SCHEMA_INVALID payload, never a crash — classifySchema turns `false` into
      // the distinct rejection code (05 §8).
      return {
        kind: 'known',
        validate: (payload) => {
          try {
            schema.parse(payload);
            return true;
          } catch {
            return false;
          }
        },
      };
    },
  };
}

/**
 * The default server op registry (05 §8), derived from SERVER_MODULES.
 *
 * Carries the `platform.*` (task 17), `auth.*` (task 43), and `notes.*` (task 25) types — all now
 * registered in the list above. The pipeline suite still injects
 * a registry covering the types IT pushes rather than relying on this one. The SAME list feeds
 * `projections` below, so a validated type always has an applier and vice versa.
 */
export const serverOpRegistry: OpRegistry = deriveOpRegistry(serverModuleRegistry);

export interface ServerDeps {
  readonly now: () => number;
  readonly newRequestId: () => string;
  readonly forTenant: ForTenant;
  readonly verifyToken: VerifyToken;
  /** The cross-tenant auth lookups (D14) — used by verifyToken and login (task 13). */
  readonly authDirectory: AuthDirectory;
  /** Fixed-window / lockout store for the api/02-auth §9 identity limits (task 13). */
  readonly identityRateStore: WindowLimitStore;
  /** On-revoke hook registry — task 20 registers socket-close (SEC-RT-02) into it (task 13). */
  readonly revocationHooks: RevocationHooks;
  /** Server password KDF (argon2id) — injected so login is testable + fast (task 13). */
  readonly passwordKdf: PasswordKdf;
  readonly perIpStore: RateLimitStore;
  readonly perDeviceStore: RateLimitStore;
  readonly loginIpPerMinute: number;
  readonly deviceRateLimits: DeviceRateLimits;
  readonly accessLogSink: AccessLogSink;
  readonly bodyCaps: (path: string) => BodyCaps;
  readonly clientIp: (c: Context<AppEnv>) => string;
  /** Ed25519 verify + SHA-256 over JCS bytes for the push pipeline (05 §3; task 16 sync push). */
  readonly serverCrypto: CryptoPort;
  /** Fresh ids for `device_anomalies` rows the push pipeline writes (05 §3). */
  readonly newOpLogId: () => string;
  /** (type, schemaVersion) → payload validator for the push pipeline (05 §8). Derived from
   *  SERVER_MODULES — `platform.*` + `auth.*` + `notes.*` (25), all registered. */
  readonly opRegistry: OpRegistry;
  /** Op type → projection applier (04 §4) for the push pipeline's apply step (10-db §3 step 6).
   *  Derived from the SAME SERVER_MODULES list as `opRegistry` — the `platform` appliers
   *  (`conflicts` + `user_prefs`) and the `auth` appliers (`auth_sessions` + `pin_lockout_events` +
   *  `auth_permission_denials`) and the `notes` applier (task 25, registered). */
  readonly projections: ProjectionRegistry<DB>;
  /** Conflict detection (01 §8.2), run inside the push transaction. `undefined` ⇒ disabled — the
   *  v0 default, because no `SystemKeyStore` is configured (conflict-wiring.ts). Built from
   *  SERVER_MODULES + the injected key store when one is present. */
  readonly detectConflicts?: DetectConflictsFn;
  /** The outward-facing push sender (api/04-push §7). Default in production is `ExpoPushSender`,
   *  built from `EXPO_ACCESS_TOKEN` and injected by main.ts (`pushPortFromConfig`); the field
   *  default here is `unconfiguredPushPort` (throws on use, never a silent no-op — task 134); tests
   *  bind `FakePushPort`. */
  readonly pushPort: PushPort;
  /** The bundle the fanout trigger functions (fanout.ts) receive — `pushPort` + `forTenant` + the
   *  live-connection registry (the realtime hub), sync coalescer, receipt scheduler and clock.
   *  Built once from the resolved `pushPort`; the sync-wake / revocation / anomaly / conflict
   *  deliveries all run through it (task 134). */
  readonly pushDelivery: PushDeliveryDeps;
  /** The fire-and-forget boundary (api/04-push §1/§6): every delivery is handed to this OFF the
   *  request path, so an in-contract Expo outage can never block or fail a sync push. Production is
   *  `ImmediateDeliveryDispatcher`; tests install one and `flush()` before asserting (task 134). */
  readonly deliveryDispatcher: DeliveryDispatcher;
  /** Post-commit hook for surfaced (significant) conflicts (03 §7). Bound by default to deliver push
   *  category `conflict` through `pushDelivery` (task 134); an override wins (tests). */
  readonly onConflictSurfaced?: (conflict: SurfacedConflict) => Promise<void>;
  /** Post-commit hook for a device that tripped an anomaly this batch (api/04-push §3). Bound by
   *  default to deliver push category `device` through `pushDelivery` (task 134). */
  readonly onDeviceAnomaly?: (params: {
    readonly tenantId: string;
    readonly deviceId: string;
  }) => Promise<void>;
  /** The deployment-owned source of tenant system-device signing keys (01 §3.6, 10-db §12).
   *  Absent in v0 — no secret-store loader exists yet (filed as a deployment task); its presence
   *  is what ENABLES conflict detection. */
  readonly systemKeyStore?: SystemKeyStore;
  /** In-process scoped `sync.poke` hub (api/00 §12.1); default has zero subscribers (task 20 subs). */
  readonly pokeHub: PokeHub;
  /** One-shot delay seam for the realtime hub's coalescing + keepalive (api/00 §12.1; T-6). Default
   *  wraps `unref`'d node timers; tests inject a controllable fake. */
  readonly realtimeScheduler: HubScheduler;
  /** WS/SSE fan-out hub (api/00 §12.1). `createRealtimeRouter` subscribes it to `pokeHub` and
   *  registers a revocation hook (SEC-RT-02); the WS/SSE routes register connections into it. */
  readonly realtimeHub: RealtimeHub;
  /** TEST-ONLY observability: called with a route key when a stub handler executes. */
  readonly onStub?: (routeKey: string) => void;
  /** TEST-ONLY observability: cumulative decompressed bytes per gzip request (bound witness). */
  readonly gzipOnProgress?: (decompressedBytesSoFar: number) => void;
}

/** The X-Forwarded-For / fallback IP source. Production overrides this with node-server's
 *  getConnInfo in main.ts; the header path keeps the app testable via app.fetch. */
export function defaultClientIp(c: Context<AppEnv>): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded !== undefined && forwarded !== '') {
    return forwarded.split(',')[0]?.trim() ?? 'unknown';
  }
  return 'unknown';
}

export function resolveDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  const now = overrides.now ?? (() => Date.now());
  // The auth directory is resolved first: the default verifyToken is the DB-backed token store
  // over it (task 13 fills task 12's injected seam — its default was an empty store).
  const authDirectory = overrides.authDirectory ?? dbAuthDirectory;

  // Conflict detection is ENABLED IFF a system key store is present (conflict-wiring.ts header):
  // detection must sign `platform.conflict_detected` with the tenant system-device key, which comes
  // from the deployment-owned secret store — in production, main.ts builds one from `SYSTEM_KEY_DIR`
  // (task 78; 08-stack-and-repo §8.1). With no store, `detectConflicts` stays undefined and the push
  // pipeline skips detection — the honest no-op, exactly like an empty SERVER_MODULES folds nothing.
  // This decision is made ONCE, server-wide: it is NOT re-evaluated per tenant, so with a store
  // present a tenant lacking a key fails loudly at emission rather than skipping detection.
  // An explicit override wins for tests.
  const forTenant = overrides.forTenant ?? dbForTenant;
  const newOpLogId = overrides.newOpLogId ?? (() => uuidv7(now()));
  const serverCrypto = overrides.serverCrypto ?? serverCryptoPort;
  const realtimeScheduler = overrides.realtimeScheduler ?? nodeHubScheduler;

  // The realtime hub doubles as the push fan-out's `LiveConnectionRegistry` (hub.isConnected): a
  // `sync` push goes ONLY to devices with no live WS/SSE connection (api/04-push §6) — the poke
  // already covers the connected ones. One hub instance, so the two channels can never disagree
  // about who is connected.
  const realtimeHub =
    overrides.realtimeHub ?? new RealtimeHub({ now, scheduler: realtimeScheduler });

  // The push port (api/04-push §7). Default is `unconfiguredPushPort` (throws on use — never a
  // silent no-op, task 134); main.ts overrides it with the production `ExpoPushSender` and tests
  // bind `FakePushPort`. `pushDelivery` bundles it with everything the fanout triggers need.
  const pushPort = overrides.pushPort ?? unconfiguredPushPort;
  const pushDelivery: PushDeliveryDeps = overrides.pushDelivery ?? {
    forTenant,
    pushPort,
    liveConnections: realtimeHub,
    coalescer: new InMemorySyncCoalescer(),
    receiptScheduler: timerReceiptScheduler,
    now,
    logger: (event) => console.warn('[push] dispatch failed', event),
  };
  const deliveryDispatcher = overrides.deliveryDispatcher ?? new ImmediateDeliveryDispatcher();

  // The post-commit delivery hooks the push pipeline fires (pipeline.ts). Bound by DEFAULT here —
  // this is the wiring task 134 restored: before it, `onConflictSurfaced` was set only by tests and
  // the chaos harness, so a shipping server surfaced conflicts and delivered nothing. An override
  // still wins (the pipeline suites inject their own recorder).
  //
  // CRITICAL (api/04-push §1/§6): the default dispatches the delivery FIRE-AND-FORGET and returns
  // immediately. The pipeline `await`s this hook post-commit, so it must resolve without waiting on
  // the Expo round-trip (network I/O + retry backoff up to minutes) — otherwise an in-contract Expo
  // outage would block the sync-push response and make push load-bearing on the latency axis.
  const onConflictSurfaced: ServerDeps['onConflictSurfaced'] =
    overrides.onConflictSurfaced ??
    ((conflict: SurfacedConflict) => {
      deliveryDispatcher.dispatch(() => sendConflictSurfaced(pushDelivery, conflict));
      return Promise.resolve();
    });
  const onDeviceAnomaly: ServerDeps['onDeviceAnomaly'] =
    overrides.onDeviceAnomaly ??
    ((params: { tenantId: string; deviceId: string }) => {
      deliveryDispatcher.dispatch(() =>
        sendDeviceAlert(pushDelivery, {
          tenantId: params.tenantId,
          aboutDeviceId: params.deviceId,
        }),
      );
      return Promise.resolve();
    });

  const detectConflicts =
    overrides.detectConflicts ??
    (overrides.systemKeyStore === undefined
      ? undefined
      : buildConflictDetection({
          modules: SERVER_MODULES,
          keyStore: overrides.systemKeyStore,
          crypto: serverCrypto,
          now,
          newId: newOpLogId,
        }));

  return {
    now,
    newRequestId: overrides.newRequestId ?? (() => uuidv7(now())),
    forTenant,
    authDirectory,
    verifyToken: overrides.verifyToken ?? createDbVerifyToken(authDirectory, now),
    identityRateStore: overrides.identityRateStore ?? new InMemoryWindowLimitStore(),
    revocationHooks: overrides.revocationHooks ?? new RevocationHooks(),
    passwordKdf: overrides.passwordKdf ?? noblePasswordKdf,
    perIpStore: overrides.perIpStore ?? new InMemoryRateLimitStore(),
    perDeviceStore: overrides.perDeviceStore ?? new InMemoryRateLimitStore(),
    loginIpPerMinute: overrides.loginIpPerMinute ?? DEFAULT_LOGIN_IP_PER_MINUTE,
    deviceRateLimits: overrides.deviceRateLimits ?? DEFAULT_DEVICE_RATE_LIMITS,
    accessLogSink: overrides.accessLogSink ?? consoleAccessLogSink,
    bodyCaps: overrides.bodyCaps ?? defaultBodyCaps,
    clientIp: overrides.clientIp ?? defaultClientIp,
    serverCrypto,
    newOpLogId,
    opRegistry: overrides.opRegistry ?? serverOpRegistry,
    projections: overrides.projections ?? serverModuleRegistry.projections,
    pokeHub: overrides.pokeHub ?? new InProcessPokeHub(),
    realtimeScheduler,
    realtimeHub,
    pushPort,
    pushDelivery,
    deliveryDispatcher,
    onConflictSurfaced,
    onDeviceAnomaly,
    ...(detectConflicts === undefined ? {} : { detectConflicts }),
    ...(overrides.systemKeyStore === undefined ? {} : { systemKeyStore: overrides.systemKeyStore }),
    ...(overrides.onStub !== undefined ? { onStub: overrides.onStub } : {}),
    ...(overrides.gzipOnProgress !== undefined ? { gzipOnProgress: overrides.gzipOnProgress } : {}),
  };
}
