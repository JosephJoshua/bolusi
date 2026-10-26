// Catalog sub-router: the crawled phone models a device keeps for offline model search
// (catalog/crawl.ts fills them). Any enrolled device may read them; they are the same public
// reference data for every tenant, so no tenant transaction is opened.
//
//   GET /v1/catalog/phones?after=<revision>   the models changed after that revision, oldest first
//   GET /v1/catalog/phones/:id/photo           one model's photo, fetched when the screen shows it
import { Hono } from 'hono';
import { z } from 'zod';

import {
  PHONE_CATALOG_PAGE_LIMIT,
  zPhoneCatalogQuery,
  type PhoneCatalogPage,
} from '@bolusi/schemas';

import type { ServerDeps } from '../deps.js';
import type { AppEnv } from '../env.js';
import { ApiError } from '../errors.js';
import { zQuery } from '../middleware/validator-hook.js';

const zModelId = z.coerce.number().int().positive().max(2_147_483_647);

export function createCatalogRouter(deps: ServerDeps) {
  return new Hono<AppEnv>()
    .use('*', async (c, next) => {
      // Devices only: the catalog is for the intake screen, not for owner control sessions.
      if (c.get('device') === undefined) throw new ApiError('AUTH_TOKEN_INVALID');
      await next();
    })
    .get('/phones', zQuery(zPhoneCatalogQuery), async (c) => {
      const { after, limit } = c.req.valid('query');
      // One extra row says whether another page follows.
      const rows = await deps.phoneCatalog.models(
        after,
        Math.min(limit, PHONE_CATALOG_PAGE_LIMIT) + 1,
      );
      const body: PhoneCatalogPage = { models: rows.slice(0, limit), more: rows.length > limit };
      return c.json(body);
    })
    .get('/phones/:id/photo', async (c) => {
      const id = zModelId.safeParse(c.req.param('id'));
      if (!id.success) throw new ApiError('NOT_FOUND');
      const photo = await deps.phoneCatalog.photo(id.data);
      if (photo === null) throw new ApiError('NOT_FOUND');
      const etag = `"${photo.sha256}"`;
      // A photo never changes under its hash, so a device may keep it as long as it likes.
      c.header('ETag', etag);
      c.header('Cache-Control', 'private, max-age=31536000, immutable');
      if (c.req.header('If-None-Match') === etag) return c.body(null, 304);
      c.header('Content-Type', photo.mime);
      return c.body(photo.bytes as Uint8Array<ArrayBuffer>);
    });
}
