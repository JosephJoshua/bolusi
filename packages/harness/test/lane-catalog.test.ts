// The QA lane's catalog phones reach a device the way crawled ones do: through the real catalog
// route, served from the harness server's own database.
import { createHash } from 'node:crypto';

import { zPhoneCatalogPage } from '@bolusi/schemas';
import { afterEach, expect, test } from 'vitest';

import { mintIdentities } from '../src/identities.js';
import { LANE_CATALOG, seedLaneCatalog } from '../src/lane-catalog.js';
import { HarnessServer } from '../src/server.js';

const BASE = 'http://srv.test/v1/catalog/phones';

let server: HarnessServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

test('a lane device downloads the seeded models with specs and fetches their photos', async () => {
  server = await HarnessServer.boot();
  const { auth } = await server.seedDevice(mintIdentities(7, 1).devices[0]!);
  const empty = await server.fetch(`${BASE}?after=0`, { headers: { Authorization: auth } });
  expect(zPhoneCatalogPage.parse(await empty.json()).models).toEqual([]);

  expect(await seedLaneCatalog(server)).toBe(LANE_CATALOG.length);

  const res = await server.fetch(`${BASE}?after=0`, { headers: { Authorization: auth } });
  expect(res.status).toBe(200);
  const page = zPhoneCatalogPage.parse(await res.json());
  expect(page.models.map((m) => m.id).sort()).toEqual(LANE_CATALOG.map((m) => m.listed.id).sort());
  const a55 = page.models.find((m) => m.name === 'Galaxy A55');
  expect(a55).toMatchObject({
    brand: 'Samsung',
    announcedYear: 2024,
    modelCodes: 'SM-A556B, SM-A556E',
  });
  expect(a55?.specs.colors).toContain('Awesome Iceblue');

  const photo = await server.fetch(`${BASE}/${a55!.id}/photo`, {
    headers: { Authorization: auth },
  });
  expect(photo.status).toBe(200);
  expect(photo.headers.get('content-type')).toBe('image/png');
  const bytes = new Uint8Array(await photo.arrayBuffer());
  expect([...bytes.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]); // "PNG"
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(a55?.photoSha256);
});
