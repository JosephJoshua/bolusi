// Composition dependencies for the Hono app. Everything the middleware chain and stub routers
// touch that is an I/O boundary or a not-yet-built collaborator is injected here — so tests swap
// fakes (rate-limit stores, token verifier, forTenant, clock) and later tasks (13/16/…) drop in
// real implementations without reshaping the skeleton.
import { forTenant as dbForTenant, type DB, type ForTenant } from '@bolusi/db-server';
import {
  registerModules,
  type AnyModuleDefinition,
  type CryptoPort,
  type ModuleRegistry,
  type OperationDeclaration,
  type ProjectionRegistry,
} from '@bolusi/core';
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
import { serverCryptoPort, type OpRegistry } from './oplog/index.js';
import { InProcessPokeHub, type PokeHub } from './realtime/poke-hub.js';
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
 * The server's module list — the ONE list tasks 17 (platform), 25 (notes), 43 (auth) append their
 * `defineModule` result to. `registerModules` turns it into BOTH the op-payload validators the push
 * pipeline's schema step consumes AND the projection appliers its apply step runs (10-db §3 step 6),
 * so validation and folding can never name different module sets (CLAUDE.md §2.8). This is the ring
 * task 49 closed: 08 punted server embedding to "07/16", 16 to "17", 25 assumed "the registration
 * list nobody creates" — all pointing at a list that did not exist. It exists here now.
 *
 * EMPTY at v0: no module ships appliers yet (17/25/43 are todo). With an empty list every pushed op
 * resolves `unknown` → `UNKNOWN_TYPE` and every accepted op folds as a defined no-op — the honest
 * state of a server that folds no modules, not a silent gap.
 */
export const SERVER_MODULES: readonly AnyModuleDefinition<DB>[] = [];

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
    resolve(type) {
      const declaration = byType.get(type);
      if (declaration === undefined) return { kind: 'unknown' };
      // `.strict()` payload schema (04 §3): a parse throw is a SCHEMA_INVALID payload, never a
      // crash — classifySchema turns `false` into the distinct rejection code (05 §8).
      return {
        kind: 'known',
        validate: (payload) => {
          try {
            declaration.payload.parse(payload);
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
 * The default server op registry (05 §8), derived from SERVER_MODULES. EMPTY today (⇒ every pushed
 * op is `UNKNOWN_TYPE`), which is why the pipeline suite injects a registry covering the types it
 * pushes. When 17/25/43 add their modules, the SAME list feeds `projections` below, so a validated
 * type always has an applier and vice versa.
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
  /** (type, schemaVersion) → payload validator for the push pipeline (05 §8). Empty by default. */
  readonly opRegistry: OpRegistry;
  /** Op type → projection applier (04 §4) for the push pipeline's apply step (10-db §3 step 6).
   *  Derived from the SAME SERVER_MODULES list as `opRegistry`; empty by default. */
  readonly projections: ProjectionRegistry<DB>;
  /** In-process scoped `sync.poke` hub (api/00 §12.1); default has zero subscribers (task 20 subs). */
  readonly pokeHub: PokeHub;
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
  return {
    now,
    newRequestId: overrides.newRequestId ?? (() => uuidv7(now())),
    forTenant: overrides.forTenant ?? dbForTenant,
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
    serverCrypto: overrides.serverCrypto ?? serverCryptoPort,
    newOpLogId: overrides.newOpLogId ?? (() => uuidv7(now())),
    opRegistry: overrides.opRegistry ?? serverOpRegistry,
    projections: overrides.projections ?? serverModuleRegistry.projections,
    pokeHub: overrides.pokeHub ?? new InProcessPokeHub(),
    ...(overrides.onStub !== undefined ? { onStub: overrides.onStub } : {}),
    ...(overrides.gzipOnProgress !== undefined ? { gzipOnProgress: overrides.gzipOnProgress } : {}),
  };
}
