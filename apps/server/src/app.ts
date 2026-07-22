// The Hono app: the normative middleware chain (api/00 §13), the §6/§7 error-envelope mapping,
// and the eight sub-routers mounted under /v1 as chained routers (§14 — chaining is what makes
// RPC inference work; `AppType` is exported for the type-only `@bolusi/server/client` subpath).
//
// Middleware order is load-bearing (§13): bearerAuth cheap-fails before bodyLimit reads bytes;
// the WIRE cap precedes decompression; the DECOMPRESSED cap precedes parse. Do not reorder.
import { compress } from 'hono/compress';
import { bodyLimit } from 'hono/body-limit';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requestId } from 'hono/request-id';

import { resolveDeps, type ServerDeps } from './deps.js';
import type { AppEnv } from './env.js';
import { ApiError, respondError } from './errors.js';
import { PermissionDeniedError, recordPermissionDenial } from './identity/denial-audit.js';
import { sendDeviceAlert } from './push/fanout.js';
import { accessLog } from './middleware/access-log.js';
import { bearerAuth } from './middleware/auth.js';
import { gzipDecompress } from './middleware/gzip-decompress.js';
import { perDeviceRateLimit, perIpRateLimit } from './middleware/rate-limit.js';
import { serverTime } from './middleware/server-time.js';
import { createAuthRouter } from './routes/auth.js';
import { createDevicesRouter } from './routes/devices.js';
import { createMediaRouter } from './routes/media.js';
import { createPushRouter } from './routes/push.js';
import { createRealtimeRouter } from './routes/realtime.js';
import { createSyncRouter } from './routes/sync.js';
import { createTenantRouter } from './routes/tenant.js';
import { createUsersRouter } from './routes/users.js';

const LOGIN_PATH = '/v1/auth/login';

/** Realtime routes carry the reduced chain (§13 last line): no compress, no body middleware. */
function isRealtime(path: string): boolean {
  return path === '/v1/realtime' || path.startsWith('/v1/realtime/');
}

/**
 * Media routes carry their OWN per-route chain (api/03-media §7; task 19): the sync gzip middleware
 * is NOT mounted (encoded chunk → 415), the body caps are per-endpoint (16 KiB init/complete, 262144
 * chunk) with media error codes (CHUNK_TOO_LARGE), and chunk PUT is rate-limited at 600/min/device
 * (others 120). So media is excluded from the app-level compress, per-device limiter, and body/gzip
 * steps and handles all three inside `createMediaRouter`. bearerAuth (§13 step 6) still applies.
 */
function isMedia(path: string): boolean {
  return path === '/v1/media' || path.startsWith('/v1/media/');
}

/**
 * Build the app from injected dependencies. Production uses the defaults (`resolveDeps`); tests
 * swap fakes. The return value is the fully chained router — `typeof` it is `AppType` (§14).
 */
export function createApp(overrides: Partial<ServerDeps> = {}) {
  const deps = resolveDeps(overrides);
  const app = new Hono<AppEnv>();

  // PUSH `device` ALERT ON REVOCATION (api/04-push §3; task 134). The revoke handler fires this hook
  // post-commit (routes/devices.ts → revocationHooks.fire), the SAME registry the realtime
  // socket-close hook uses (routes/realtime.ts). Owner devices (auth.device_read holders) are told a
  // device was revoked. The delivery is DISPATCHED fire-and-forget (api/04-push §1/§6): the hook
  // returns immediately, so the awaited `revocationHooks.fire` never waits on the Expo round-trip —
  // a revocation must not block or fail on a push. Registered once, at composition, so it can never
  // be the "only tests installed it" defect this task removed.
  deps.revocationHooks.register((ctx) => {
    deps.deliveryDispatcher.dispatch(() =>
      sendDeviceAlert(deps.pushDelivery, { tenantId: ctx.tenantId, aboutDeviceId: ctx.deviceId }),
    );
  });

  // Error envelope (§6/§7). A thrown ApiError maps to its registry code; anything else is an
  // unhandled server error → 500 INTERNAL with the request id (§7).
  app.onError(async (err, c) => {
    // The single FR-1045 server-denial emission point (02-permissions §7 declare/emit split): a
    // handler DECLARES the denial by throwing PermissionDeniedError; this writes the one
    // `identity_audit` row, in its OWN forTenant tx (the request's tx has already rolled back), and
    // is never permission-checked (non-recursion). Best-effort so a denial's audit-write fault
    // never converts a 403 into a 500 — the deny is the security decision, the audit is evidence
    // (the same fail-safe as the client arm; surfacing a persistent audit-write fault is task 99).
    if (err instanceof PermissionDeniedError) {
      const device = c.get('device');
      const tenantId = device?.tenantId ?? c.get('controlSession')?.tenantId;
      if (tenantId !== undefined) {
        try {
          await recordPermissionDenial(deps.forTenant, {
            tenantId,
            target: `${c.req.method} ${c.req.path}`,
            deviceId: device?.deviceId ?? null,
            denial: err.denial,
            at: deps.now(),
          });
        } catch {
          // Best-effort: deny is the security decision, the audit row is evidence. A failed append
          // must never turn a 403 into a 500 (task-10 fail-safe, mirrored on the client arm).
          // Surfacing a *persistent* audit-write fault is task 99's cross-cutting item, not here.
        }
      }
      return respondError(c, err.code, err.details);
    }
    if (err instanceof ApiError) {
      return respondError(c, err.code, err.details);
    }
    // Unparseable JSON body (api/00 §7 "Unparseable JSON → 400 MALFORMED_REQUEST"): Hono's json
    // validator catches the parse failure and throws HTTPException(400, "Malformed JSON …") BEFORE
    // the §7.1 hook can run — so it surfaces here, not as a 422. Map its 400 to the §7 envelope,
    // never a 500 (SEC-SYNC-06). This is a task-12 gap the sync malformed-input tests exposed.
    if (err instanceof HTTPException && err.status === 400) {
      return respondError(c, 'MALFORMED_REQUEST');
    }
    return respondError(c, 'INTERNAL', { requestId: c.get('requestId') });
  });
  app.notFound((c) => respondError(c, 'NOT_FOUND'));

  // §13 step 1: request id (UUIDv7 per request, §5.1).
  app.use('*', requestId({ generator: () => deps.newRequestId() }));
  // §13 step 2: stamps X-Server-Time + X-Request-Id on EVERY response (§9).
  app.use('*', serverTime({ now: deps.now }));
  // §13 step 3: access log (code+path+requestId+deviceId; never tokens/bodies).
  app.use('*', accessLog({ sink: deps.accessLogSink }));

  // §13 step 4: response compression — excluded from WS/SSE (§12.1) and from media (raw,
  // already-compressed bytes; download must keep an exact Content-Length + ETag — api/03 §3.5).
  const compressor = compress();
  app.use('*', async (c, next) =>
    isRealtime(c.req.path) || isMedia(c.req.path) ? next() : compressor(c, next),
  );

  // §13 step 5: per-IP limit, pre-auth, login only.
  app.use(
    LOGIN_PATH,
    perIpRateLimit({
      store: deps.perIpStore,
      capacityPerMinute: deps.loginIpPerMinute,
      now: deps.now,
      clientIp: deps.clientIp,
    }),
  );

  // §13 step 6: bearerAuth on all /v1 routes except the exempt login (§3).
  const auth = bearerAuth({ verifyToken: deps.verifyToken });
  app.use('/v1/*', async (c, next) => (c.req.path === LOGIN_PATH ? next() : auth(c, next)));

  // §13 step 7: per-device limit (keyed by the device from step 6; realtime bucket for realtime).
  // Media is excluded — it owns per-endpoint device buckets (chunk 600/min, others 120/min —
  // api/03 §8) inside createMediaRouter, reusing this same token-bucket store.
  const deviceLimiter = perDeviceRateLimit({
    store: deps.perDeviceStore,
    limits: deps.deviceRateLimits,
    now: deps.now,
    isRealtime,
  });
  app.use('/v1/*', async (c, next) => (isMedia(c.req.path) ? next() : deviceLimiter(c, next)));

  // §13 steps 8–9: wire-byte cap then decompressed-byte cap. Realtime routes carry no body
  // middleware (reduced chain). Caps are per route class (§5.3).
  app.use('/v1/*', async (c, next) => {
    // Realtime + media carry the reduced chain (no app-level body/gzip). Media applies its own
    // per-endpoint bodyLimit + Content-Encoding rejection inside createMediaRouter (api/03 §7).
    if (isRealtime(c.req.path) || isMedia(c.req.path)) {
      await next();
      return;
    }
    const caps = deps.bodyCaps(c.req.path);
    const gzipOptions =
      deps.gzipOnProgress !== undefined
        ? { maxDecompressedBytes: caps.decompressedBytes, onProgress: deps.gzipOnProgress }
        : { maxDecompressedBytes: caps.decompressedBytes };
    await bodyLimit({
      maxSize: caps.wireBytes,
      onError: () => {
        throw new ApiError('BODY_TOO_LARGE', { limitBytes: caps.wireBytes });
      },
    })(c, async () => {
      await gzipDecompress(gzipOptions)(c, next);
    });
  });

  // §13 steps 10–11: validators live on the routes (shared 422 hook); handlers open the tenant
  // transaction via the tenant helper (task 16+). Mounted chained under /v1 (§14).
  return app
    .route('/v1/auth', createAuthRouter(deps))
    .route('/v1/devices', createDevicesRouter(deps))
    .route('/v1/users', createUsersRouter(deps))
    .route('/v1/tenant', createTenantRouter(deps))
    .route('/v1/sync', createSyncRouter(deps))
    .route('/v1/media', createMediaRouter(deps))
    .route('/v1/push', createPushRouter(deps))
    .route('/v1/realtime', createRealtimeRouter(deps));
}

/** The production app instance (default deps): the RPC contract surface + boot handler. */
export const routes = createApp();

/** The precompiled RPC contract (§14). Consumed type-only via `@bolusi/server/client`. */
export type AppType = typeof routes;
