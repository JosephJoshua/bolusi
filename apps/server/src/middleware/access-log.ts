// Access logging (api/00 §13 step 3). Logs exactly code + path + requestId + deviceId —
// NEVER the Authorization header, the bearer token, or any request/response body (§3: tokens
// never appear in logs; SEC-SECRET-01). The log record is a structured object handed to an
// injected sink so tests can assert its shape without scraping stdout.
import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../env.js';

export interface AccessLogRecord {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly requestId: string;
  /** Present only once bearerAuth has set a device principal; omitted otherwise. */
  readonly deviceId?: string;
}

export type AccessLogSink = (record: AccessLogRecord) => void;

export const consoleAccessLogSink: AccessLogSink = (record) => {
  // The access log's sink is deliberately stdout in production.
  console.log(JSON.stringify({ msg: 'access', ...record }));
};

/**
 * Paths that carry a credential, never logged: a phone handoff's pairing key, and a customer's
 * status link code (its page and its data).
 */
const loggedPath = (path: string): string =>
  path
    .replace(/^\/h\/[^/]+/, '/h/:key')
    .replace(/^\/c\/[^/]+/i, '/c/:code')
    .replace(/^\/v1\/public\/status\/[^/]+/i, '/v1/public/status/:code');

export function accessLog(options: { sink: AccessLogSink }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const deviceId = c.get('device')?.deviceId;
    const path = loggedPath(c.req.path);
    const record: AccessLogRecord =
      deviceId === undefined
        ? {
            method: c.req.method,
            path,
            status: c.res.status,
            requestId: c.get('requestId'),
          }
        : {
            method: c.req.method,
            path,
            status: c.res.status,
            requestId: c.get('requestId'),
            deviceId,
          };
    options.sink(record);
  };
}
