// Shell app (08 §4.3: chained sub-routers → export type AppType). Real sub-routers,
// middleware chain, and the error envelope land with task 12 (server-app).
// The /health route doubles as the bootstrap witness that @hono/zod-validator 0.8.0
// and zod 4.4.3 type-check together (08 §7 record).
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

const healthQuerySchema = z.object({
  verbose: z.enum(['0', '1']).optional(),
});

export const routes = new Hono().get('/health', zValidator('query', healthQuerySchema), (c) =>
  c.json({ ok: true as const }),
);

export type AppType = typeof routes;
