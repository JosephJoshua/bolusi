// X-Server-Time + X-Request-Id on EVERY response (api/00 §5.1, §9, §13 step 2) — success,
// error, 404, 413, 422, 429, 500 alike. Both are stamped AFTER next(): Hono's compose routes a
// thrown error through onError at the throwing frame, so an outer middleware's post-next code
// still runs for error responses (and c.header after finalization rewrites the response headers,
// mutable). X-Request-Id is re-stamped here too — hono/request-id sets it pre-next into prepared
// headers, which are not merged onto an onError response.
import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../env.js';

export function serverTime(options: { now: () => number }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    // §9: stamped at response generation, integer ms epoch.
    c.header('X-Server-Time', String(options.now()));
    c.header('X-Request-Id', c.get('requestId'));
  };
}
