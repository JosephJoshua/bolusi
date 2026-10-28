// The customer's status page data (product-scope.md, "Customers follow their repair online"). No
// token: the link code printed on the slip is the credential, so this route sits outside bearer
// auth and is limited per IP instead.
//
//   GET /v1/public/status/:code   the servisan as the customer sees it (@bolusi/schemas
//                                 PublicRepairStatus), 404 for an unknown code, and 404 with
//                                 `details.reason: 'ended'` once the page has closed
//
// A code resolves through the one definer lookup for it (db-server findStatusLink), then every read
// runs in that tenant's own transaction, pinned to the servisan's store.
import { Hono } from 'hono';

import { normalizeStatusCode, readCustomerStatus } from '@bolusi/modules/repair';
import type { PublicRepairStatus } from '@bolusi/schemas';

import type { ServerDeps } from '../deps.js';
import type { AppEnv } from '../env.js';
import { ApiError } from '../errors.js';
import { enforceBucket } from '../middleware/rate-limit.js';

/**
 * Lookups per IP per minute. Generous, because many customers share one carrier address; a code has
 * 50 random bits, so guessing stays hopeless at this rate.
 */
export const PUBLIC_STATUS_IP_PER_MINUTE = 120;

/** The page must never be cached by a proxy or indexed: the link is a credential. */
const PRIVATE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex',
  'Referrer-Policy': 'no-referrer',
} as const;

export function createPublicStatusRouter(deps: ServerDeps) {
  return new Hono<AppEnv>().get('/:code', async (c) => {
    enforceBucket(
      deps.perIpStore,
      `status:${deps.clientIp(c)}`,
      PUBLIC_STATUS_IP_PER_MINUTE,
      deps.now(),
    );
    for (const [name, value] of Object.entries(PRIVATE_HEADERS)) c.header(name, value);
    const code = normalizeStatusCode(c.req.param('code'));
    const link = code === null ? undefined : await deps.authDirectory.findStatusLink(code);
    if (link === undefined) throw new ApiError('NOT_FOUND');

    const read = await deps.forTenant(link.tenantId, async (db) => {
      const store = await db
        .selectFrom('stores')
        .select('name')
        .where('id', '=', link.storeId)
        .executeTakeFirst();
      return readCustomerStatus(
        db as unknown as Parameters<typeof readCustomerStatus>[0],
        link,
        store?.name ?? '',
        deps.now(),
      );
    });
    if (read.kind === 'missing') throw new ApiError('NOT_FOUND');
    if (read.kind === 'ended') throw new ApiError('NOT_FOUND', { reason: 'ended' });
    return c.json<PublicRepairStatus>(read.status);
  });
}
