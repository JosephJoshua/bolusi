import { expect, test } from 'vitest';

import { routes } from './app.js';

test('@bolusi/server shell serves /health through the zod-validated route', async () => {
  const res = await routes.request('/health');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test('@bolusi/server shell rejects invalid query per zValidator', async () => {
  const res = await routes.request('/health?verbose=nope');
  expect(res.status).toBe(400);
});
