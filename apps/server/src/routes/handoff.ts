// The phone handoff (handoff/relay.ts): the counter PC's side under /v1 with its device token, and
// the store phone's page outside it, reached only by the pairing's secret key.
//
//   POST   /v1/handoff                 a new pairing (and QR) for this PC → { id, path }
//   POST   /v1/handoff/:id/ask         put a photo or signature step in front of the phone → { seq }
//   POST   /v1/handoff/:id/withdraw    the PC backed out of that step
//   GET    /v1/handoff/:id/events      what the phone did since `after`, held open a while
//   DELETE /v1/handoff/:id             end the pairing
//
//   GET    /h/:key                     the phone page
//   GET    /h/:key/next?v=             the phone's current step, held open until it changes
//   POST   /h/:key/send?seq=           a JPEG or signature strokes for that step
//
// The phone routes answer with bare statuses the page reads (410 the pairing is over, 409 the step
// was withdrawn or replaced, 413/415/400 a send it cannot take). A wrong key gets the same 410 as
// an ended one, so keys cannot be probed.
import { randomBytes } from 'node:crypto';

import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import {
  HANDOFF_LIMITS,
  HANDOFF_PAD,
  zHandoffAskBody,
  zHandoffPairBody,
  zHandoffWithdrawBody,
  type HandoffAskResponse,
  type HandoffEventsResponse,
  type HandoffPairResponse,
} from '@bolusi/schemas';

import type { ServerDeps } from '../deps.js';
import type { AppEnv, DevicePrincipal } from '../env.js';
import { ApiError } from '../errors.js';
import { handoffPage } from '../handoff/page.js';
import type { HandoffSession } from '../handoff/relay.js';
import { zJson, zQuery } from '../middleware/validator-hook.js';

const KEY = /^[A-Za-z0-9_-]{32}$/;

/** A counter PC's device token; owner control sessions have no camera to stand in for. */
function deviceOf(c: Context<AppEnv>): DevicePrincipal {
  const device = c.get('device');
  if (device === undefined) throw new ApiError('AUTH_TOKEN_INVALID');
  return device;
}

export function createHandoffRouter(deps: ServerDeps) {
  const relay = deps.handoffRelay;
  const own = (c: Context<AppEnv>): HandoffSession => {
    const session = relay.forDevice(deviceOf(c), c.req.param('id') ?? '');
    if (session === null) throw new ApiError('NOT_FOUND');
    return session;
  };

  return new Hono<AppEnv>()
    .post('/', zJson(zHandoffPairBody), (c) => {
      const session = relay.pair(deviceOf(c), c.req.valid('json').labels);
      const body: HandoffPairResponse = { id: session.id, path: `/h/${session.key}` };
      return c.json(body);
    })
    .post('/:id/ask', zJson(zHandoffAskBody), (c) => {
      const { kind, title } = c.req.valid('json');
      const body: HandoffAskResponse = { seq: relay.ask(own(c), kind, title) };
      return c.json(body);
    })
    .post('/:id/withdraw', zJson(zHandoffWithdrawBody), (c) => {
      relay.withdraw(own(c), c.req.valid('json').seq);
      return c.body(null, 204);
    })
    .get('/:id/events', zQuery(z.object({ after: z.coerce.number().int().min(0) })), async (c) => {
      const session = relay.forDevice(deviceOf(c), c.req.param('id'));
      // Ended, expired or replaced: the PC shows a new code when it next needs the phone.
      if (session === null) {
        const ended: HandoffEventsResponse = { events: [], ended: true };
        return c.json(ended);
      }
      const events = await relay.collect(session, c.req.valid('query').after, c.req.raw.signal);
      const body: HandoffEventsResponse = { events, ended: session.ended };
      return c.json(body);
    })
    .delete('/:id', (c) => {
      const session = relay.forDevice(deviceOf(c), c.req.param('id'));
      if (session !== null) relay.end(session);
      return c.body(null, 204);
    });
}

const PHONE_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const;

function bare(c: Context<AppEnv>, status: 204 | 400 | 405 | 409 | 410 | 413 | 415): Response {
  for (const [name, value] of Object.entries(PHONE_HEADERS)) c.header(name, value);
  return c.body(null, status);
}

export function createHandoffPageRouter(deps: ServerDeps) {
  const relay = deps.handoffRelay;
  const sessionOf = (c: Context<AppEnv>): HandoffSession | null => {
    const key = c.req.param('key') ?? '';
    return KEY.test(key) ? relay.forKey(key) : null;
  };

  return new Hono<AppEnv>()
    .get('/:key', (c) => {
      const session = sessionOf(c);
      if (session === null) return bare(c, 410);
      const nonce = randomBytes(16).toString('base64');
      for (const [name, value] of Object.entries(PHONE_HEADERS)) c.header(name, value);
      c.header(
        'Content-Security-Policy',
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'`,
      );
      const html = handoffPage(session.labels, nonce, HANDOFF_PAD, HANDOFF_LIMITS);
      relay.opened(session);
      return c.html(html);
    })
    .get('/:key/next', async (c) => {
      const session = sessionOf(c);
      if (session === null) return bare(c, 410);
      const seen = Number(c.req.query('v') ?? '-1');
      await relay.waitForStep(session, seen, c.req.raw.signal);
      if (session.ended) return bare(c, 410);
      for (const [name, value] of Object.entries(PHONE_HEADERS)) c.header(name, value);
      return c.json({ v: session.version, ask: session.ask });
    })
    .post(
      '/:key/send',
      bodyLimit({
        maxSize: HANDOFF_LIMITS.photoBytes,
        onError: (c) => bare(c, 413),
      }),
      async (c) => {
        const session = sessionOf(c);
        if (session === null) return bare(c, 410);
        const body = new Uint8Array(await c.req.arrayBuffer());
        if (session.ended) return bare(c, 410);
        const refused = relay.receive(session, Number(c.req.query('seq') ?? '0'), body);
        return bare(c, refused ?? 204);
      },
    )
    .all('/:key', (c) => bare(c, 405))
    .all('/:key/*', (c) => bare(c, 405));
}
