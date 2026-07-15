// Composition dependencies for the Hono app. Everything the middleware chain and stub routers
// touch that is an I/O boundary or a not-yet-built collaborator is injected here — so tests swap
// fakes (rate-limit stores, token verifier, forTenant, clock) and later tasks (13/16/…) drop in
// real implementations without reshaping the skeleton.
import { forTenant as dbForTenant, type ForTenant } from '@bolusi/db-server';
import type { Context } from 'hono';

import type { AppEnv } from './env.js';
import { consoleAccessLogSink, type AccessLogSink } from './middleware/access-log.js';
import { createVerifyToken, emptyTokenStore, type VerifyToken } from './middleware/auth.js';
import {
  InMemoryRateLimitStore,
  type DeviceRateLimits,
  type RateLimitStore,
} from './middleware/rate-limit.js';
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

export interface ServerDeps {
  readonly now: () => number;
  readonly newRequestId: () => string;
  readonly forTenant: ForTenant;
  readonly verifyToken: VerifyToken;
  readonly perIpStore: RateLimitStore;
  readonly perDeviceStore: RateLimitStore;
  readonly loginIpPerMinute: number;
  readonly deviceRateLimits: DeviceRateLimits;
  readonly accessLogSink: AccessLogSink;
  readonly bodyCaps: (path: string) => BodyCaps;
  readonly clientIp: (c: Context<AppEnv>) => string;
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
  return {
    now,
    newRequestId: overrides.newRequestId ?? (() => uuidv7(now())),
    forTenant: overrides.forTenant ?? dbForTenant,
    verifyToken: overrides.verifyToken ?? createVerifyToken({ store: emptyTokenStore, now }),
    perIpStore: overrides.perIpStore ?? new InMemoryRateLimitStore(),
    perDeviceStore: overrides.perDeviceStore ?? new InMemoryRateLimitStore(),
    loginIpPerMinute: overrides.loginIpPerMinute ?? DEFAULT_LOGIN_IP_PER_MINUTE,
    deviceRateLimits: overrides.deviceRateLimits ?? DEFAULT_DEVICE_RATE_LIMITS,
    accessLogSink: overrides.accessLogSink ?? consoleAccessLogSink,
    bodyCaps: overrides.bodyCaps ?? defaultBodyCaps,
    clientIp: overrides.clientIp ?? defaultClientIp,
    ...(overrides.onStub !== undefined ? { onStub: overrides.onStub } : {}),
    ...(overrides.gzipOnProgress !== undefined ? { gzipOnProgress: overrides.gzipOnProgress } : {}),
  };
}
