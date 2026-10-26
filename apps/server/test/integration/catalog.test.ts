// GET /v1/catalog/phones and /phones/:id/photo over the real middleware chain, with the catalog
// reads faked (their SQL is tested on Postgres in packages/db-server phone-catalog.test.ts).
import type { PhoneModelPhoto, PhoneModelRecord } from '@bolusi/db-server';
import { zPhoneCatalogPage } from '@bolusi/schemas';
import { describe, expect, test } from 'vitest';

import { enrollDevice, makeTestApp } from '../helpers/app.js';
import { readError } from '../helpers/http.js';

const BASE = 'http://srv.test/v1/catalog/phones';

function model(id: number): PhoneModelRecord {
  return {
    id,
    brand: 'Samsung',
    name: `Galaxy A${id}`,
    kind: 'phone',
    announcedYear: 2024,
    modelCodes: '',
    photoSha256: id === 1 ? 'b'.repeat(64) : null,
    specs: id === 1 ? { chipset: 'Exynos 1480 (4 nm)', usb: 'USB Type-C 2.0' } : {},
    revision: id * 10,
  };
}

const PHOTO: PhoneModelPhoto = {
  sha256: 'b'.repeat(64),
  mime: 'image/jpeg',
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 1]),
};

function harness() {
  const calls: [number, number][] = [];
  const models = [1, 2, 3].map(model);
  const h = makeTestApp({
    phoneCatalog: {
      models: async (after, limit) => {
        calls.push([after, limit]);
        return models.filter((m) => m.revision > after).slice(0, limit);
      },
      photo: async (id) => (id === 1 ? PHOTO : null),
    },
  });
  const auth = enrollDevice(h, {
    deviceId: '0190f000-0000-7000-8000-000000000001',
    tenantId: '0190f000-0000-7000-8000-0000000000aa',
    storeId: '0190f000-0000-7000-8000-0000000000bb',
    token: 'bdt_catalog0001',
  });
  return { h, auth, calls };
}

describe('the model list', () => {
  test('pages after a revision and says whether more follow', async () => {
    const { h, auth, calls } = harness();
    const first = await h.app.request(`${BASE}?after=0&limit=2`, {
      headers: { Authorization: auth },
    });
    expect(first.status).toBe(200);
    const page = zPhoneCatalogPage.parse(await first.json());
    expect(page.models.map((m) => m.id)).toEqual([1, 2]);
    expect(page.more).toBe(true);
    expect(calls).toEqual([[0, 3]]);

    const rest = await h.app.request(`${BASE}?after=20`, { headers: { Authorization: auth } });
    const last = zPhoneCatalogPage.parse(await rest.json());
    expect(last).toEqual({ models: [model(3)], more: false });
  });

  test('rejects a bad cursor or page size', async () => {
    const { h, auth } = harness();
    for (const query of ['after=-1', 'after=x', 'after=0&limit=5000', '']) {
      const res = await h.app.request(`${BASE}?${query}`, { headers: { Authorization: auth } });
      expect(res.status, query).toBe(422);
      expect((await readError(res)).error.code).toBe('VALIDATION_FAILED');
    }
  });

  test('needs an enrolled device', async () => {
    const { h } = harness();
    const res = await h.app.request(`${BASE}?after=0`);
    expect(res.status).toBe(401);
    h.tokenStore.add('ctl_owner0001', {
      kind: 'control',
      userId: '0190f000-0000-7000-8000-0000000000cc',
      tenantId: '0190f000-0000-7000-8000-0000000000aa',
      expiresAt: h.clock.now() + 60_000,
    });
    const control = await h.app.request(`${BASE}?after=0`, {
      headers: { Authorization: 'Bearer ctl_owner0001' },
    });
    expect(control.status).toBe(401);
  });
});

describe('a model photo', () => {
  test('is served with its hash as the ETag and cached for good', async () => {
    const { h, auth } = harness();
    const res = await h.app.request(`${BASE}/1/photo`, { headers: { Authorization: auth } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('ETag')).toBe(`"${PHOTO.sha256}"`);
    expect(res.headers.get('Cache-Control')).toContain('immutable');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PHOTO.bytes);

    const again = await h.app.request(`${BASE}/1/photo`, {
      headers: { Authorization: auth, 'If-None-Match': `"${PHOTO.sha256}"` },
    });
    expect(again.status).toBe(304);
  });

  test('is 404 when absent or when the id is not a model number', async () => {
    const { h, auth } = harness();
    for (const id of ['2', '0', 'abc', '1.5', '99999999999']) {
      const res = await h.app.request(`${BASE}/${id}/photo`, { headers: { Authorization: auth } });
      expect(res.status, id).toBe(404);
    }
  });
});
