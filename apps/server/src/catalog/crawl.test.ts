// The crawl loop over a fake GSMArena and an in-memory catalog: pacing, resuming, incremental
// listing, refusals, robots.txt and the photo checks. The SQL behind the real store is tested on
// Postgres in packages/db-server (phone-catalog.test.ts).
import type {
  CatalogBrand,
  ListedPhoneModel,
  PhoneCatalogWriter,
  PhoneModelDetails,
  PhoneModelPhoto,
} from '@bolusi/db-server';
import { describe, expect, test } from 'vitest';

import { GSMARENA_ORIGIN } from './gsmarena.js';
import {
  crawlPhoneCatalog,
  type CrawlDeps,
  type CrawlOptions,
  type CrawlResponse,
} from './crawl.js';

const ORIGIN = GSMARENA_ORIGIN;
const CDN = 'https://fdn2.gsmarena.com';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

interface StoredModel extends ListedPhoneModel {
  photo: PhoneModelPhoto | null;
  photoDone: boolean;
  details: PhoneModelDetails | null;
  detailsDone: boolean;
}

class MemoryCatalog implements PhoneCatalogWriter {
  readonly brandRows = new Map<string, CatalogBrand>();
  readonly models = new Map<number, StoredModel>();

  async saveBrands(brands: readonly { path: string; name: string }[]) {
    for (const b of brands) {
      this.brandRows.set(b.path, { ...b, listedAt: this.brandRows.get(b.path)?.listedAt ?? null });
    }
  }
  async brands() {
    return [...this.brandRows.values()];
  }
  async markBrandListed(path: string, at: number) {
    this.brandRows.set(path, { ...this.brandRows.get(path)!, listedAt: at });
  }
  async saveListedModels(models: readonly ListedPhoneModel[]) {
    let added = 0;
    for (const m of models) {
      const old = this.models.get(m.id);
      if (old === undefined) added += 1;
      this.models.set(m.id, {
        ...m,
        photo: old?.photo ?? null,
        photoDone: old?.photoDone ?? false,
        details: old?.details ?? null,
        detailsDone: old?.detailsDone ?? false,
      });
    }
    return added;
  }
  #pending(filter: (m: StoredModel) => boolean, limit: number) {
    return [...this.models.values()]
      .filter(filter)
      .sort((a, b) => (b.announcedYear ?? 0) - (a.announcedYear ?? 0) || b.id - a.id)
      .slice(0, limit)
      .map(({ id, pagePath, photoUrl }) => ({ id, pagePath, photoUrl }));
  }
  async modelsNeedingPhoto(limit: number) {
    return this.#pending((m) => m.photoUrl !== null && !m.photoDone, limit);
  }
  async savePhoto(id: number, photo: PhoneModelPhoto | null) {
    const model = this.models.get(id)!;
    model.photoDone = true;
    if (photo !== null) model.photo = photo;
  }
  async removePhoto(id: number) {
    const model = this.models.get(id)!;
    model.photo = null;
    model.photoDone = true;
  }
  async modelsNeedingDetails(limit: number) {
    return this.#pending((m) => !m.detailsDone, limit);
  }
  async saveDetails(id: number, details: PhoneModelDetails | null) {
    const model = this.models.get(id)!;
    model.detailsDone = true;
    model.details = details;
  }
}

function html(body: string): CrawlResponse {
  return { status: 200, retryAfterSeconds: null, body: new TextEncoder().encode(body) };
}

const MAKERS = html(
  '<div class="st-text"><a href="samsung-phones-9.php">Samsung<br><span>3 devices</span></a></div>',
);

function listing(models: [id: number, year: number][], pages: number[]): CrawlResponse {
  const items = models
    .map(
      ([id, year]) =>
        `<li><a href="samsung_galaxy_m${id}-${id}.php"><img src="${CDN}/vv/bigpic/m${id}.jpg" title="Samsung Galaxy M${id} Android smartphone. Announced Jan ${year}."><strong><span>Galaxy M${id}</span></strong></a></li>`,
    )
    .join('');
  const nav = pages.map((p) => `<a href="samsung-phones-f-9-0-p${p}.php">${p}</a>`).join('');
  return html(`<div class="makers"><ul>${items}</ul></div><div class="nav-pages">${nav}</div>`);
}

function modelPage(code: string): CrawlResponse {
  return html(`<td class="nfo" data-spec="models">${code}</td><td data-spec="year">2024, May</td>`);
}

/** A fake web plus a fake clock: sleeping advances time, every GET is recorded with its time. */
function harness(site: Record<string, CrawlResponse | CrawlResponse[]>) {
  let clock = 0;
  const gets: { url: string; at: number }[] = [];
  const sleeps: number[] = [];
  const store = new MemoryCatalog();
  const logs: string[] = [];
  const deps: CrawlDeps = {
    store,
    now: () => clock,
    random: () => 0,
    log: (line) => logs.push(line),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    get: async (url) => {
      gets.push({ url, at: clock });
      clock += 100;
      const entry = site[url];
      const response = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
      return response ?? { status: 404, retryAfterSeconds: null, body: new Uint8Array() };
    },
  };
  return { deps, store, gets, sleeps, logs };
}

const OPTIONS: CrawlOptions = { delayMs: 10_000, robotsAgent: 'BolusiCatalog' };

const SITE = {
  [`${ORIGIN}/robots.txt`]: html('User-agent: *\nDisallow: /search'),
  [`${ORIGIN}/makers.php3`]: MAKERS,
  [`${ORIGIN}/samsung-phones-9.php`]: listing(
    [
      [3, 2025],
      [2, 2024],
    ],
    [2],
  ),
  [`${ORIGIN}/samsung-phones-f-9-0-p2.php`]: listing([[1, 2019]], [2]),
  [`${CDN}/vv/bigpic/m1.jpg`]: { status: 200, retryAfterSeconds: null, body: JPEG },
  [`${CDN}/vv/bigpic/m2.jpg`]: { status: 200, retryAfterSeconds: null, body: JPEG },
  [`${CDN}/vv/bigpic/m3.jpg`]: html('<html>not an image</html>'),
  [`${ORIGIN}/samsung_galaxy_m1-1.php`]: modelPage('SM-M015F'),
  [`${ORIGIN}/samsung_galaxy_m2-2.php`]: modelPage('SM-M025F, SM-M025G'),
  [`${ORIGIN}/samsung_galaxy_m3-3.php`]: modelPage('SM-M035F'),
};

describe('a first run', () => {
  test('lists every page, then photos and pages newest first, one request at a time', async () => {
    const { deps, store, gets } = harness({ ...SITE });
    const summary = await crawlPhoneCatalog(deps, OPTIONS);

    expect(summary).toEqual({
      requests: 11,
      brands: 1,
      newModels: 3,
      photos: 2,
      details: 3,
      stoppedBy: null,
    });
    expect(gets.map((g) => g.url.replace(ORIGIN, '').replace(CDN, 'cdn'))).toEqual([
      '/robots.txt',
      '/makers.php3',
      '/samsung-phones-9.php',
      '/samsung-phones-f-9-0-p2.php',
      'cdn/robots.txt',
      'cdn/vv/bigpic/m3.jpg',
      'cdn/vv/bigpic/m2.jpg',
      'cdn/vv/bigpic/m1.jpg',
      '/samsung_galaxy_m3-3.php',
      '/samsung_galaxy_m2-2.php',
      '/samsung_galaxy_m1-1.php',
    ]);
    for (let i = 1; i < gets.length; i += 1) {
      expect(gets[i]!.at - gets[i - 1]!.at).toBeGreaterThanOrEqual(10_000);
    }
    expect(store.brandRows.get('samsung-phones-9.php')!.listedAt).not.toBeNull();
    // Not an image: recorded as having no photo, never stored.
    expect(store.models.get(3)).toMatchObject({ photo: null, photoDone: true });
    expect(store.models.get(2)!.photo).toMatchObject({ mime: 'image/jpeg' });
    expect(store.models.get(2)!.photo!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(store.models.get(2)!.details).toEqual({
      modelCodes: ['SM-M025F', 'SM-M025G'],
      announcedYear: 2024,
      specs: {},
    });
  });
});

test('a later run reads a listed brand only until a page brings nothing new', async () => {
  const { deps, gets } = harness({ ...SITE });
  await crawlPhoneCatalog(deps, OPTIONS);
  gets.length = 0;
  const summary = await crawlPhoneCatalog(deps, OPTIONS);
  expect(summary.newModels).toBe(0);
  expect(gets.map((g) => g.url)).toEqual([
    `${ORIGIN}/robots.txt`,
    `${ORIGIN}/makers.php3`,
    `${ORIGIN}/samsung-phones-9.php`,
  ]);
});

test('an interrupted first walk finishes the brand on the next run', async () => {
  const { deps, store } = harness({ ...SITE });
  const first = await crawlPhoneCatalog(deps, { ...OPTIONS, maxRequests: 3 });
  expect(first.stoppedBy).toBe('max-requests');
  expect(store.brandRows.get('samsung-phones-9.php')!.listedAt).toBeNull();
  expect([...store.models.keys()].sort()).toEqual([2, 3]);

  await crawlPhoneCatalog(deps, { ...OPTIONS, phases: ['list'] });
  expect([...store.models.keys()].sort()).toEqual([1, 2, 3]);
  expect(store.brandRows.get('samsung-phones-9.php')!.listedAt).not.toBeNull();
});

describe('refusals', () => {
  test('waits out a 429 with Retry-After, then carries on', async () => {
    const { deps, store, sleeps } = harness({
      ...SITE,
      [`${ORIGIN}/makers.php3`]: [
        { status: 429, retryAfterSeconds: 120, body: new Uint8Array() },
        MAKERS,
      ],
    });
    const summary = await crawlPhoneCatalog(deps, { ...OPTIONS, phases: ['list'] });
    expect(summary.stoppedBy).toBeNull();
    expect(sleeps).toContain(120_000);
    expect(store.models.size).toBe(3);
  });

  test('stops the run after repeated refusals, keeping what was saved', async () => {
    const refused: CrawlResponse = { status: 503, retryAfterSeconds: null, body: new Uint8Array() };
    const { deps, store, sleeps } = harness({
      ...SITE,
      [`${ORIGIN}/samsung-phones-f-9-0-p2.php`]: refused,
    });
    const summary = await crawlPhoneCatalog(deps, OPTIONS);
    expect(summary.stoppedBy).toBe('refused');
    expect(sleeps.filter((ms) => ms >= 5 * 60_000)).toEqual([
      300_000, 600_000, 1_200_000, 2_400_000,
    ]);
    expect(store.models.size).toBe(2);
    expect(store.brandRows.get('samsung-phones-9.php')!.listedAt).toBeNull();
  });

  test('a refusal doubles the gap between later requests, up to a minute', async () => {
    const { deps, gets, logs } = harness({
      ...SITE,
      [`${ORIGIN}/makers.php3`]: [
        { status: 429, retryAfterSeconds: 1, body: new Uint8Array() },
        MAKERS,
      ],
    });
    await crawlPhoneCatalog(deps, { ...OPTIONS, phases: ['list'] });
    const listing = gets.findIndex((g) => g.url.endsWith('samsung-phones-9.php'));
    expect(gets[listing + 1]!.at - gets[listing]!.at).toBeGreaterThanOrEqual(20_000);
    expect(logs).toContain('slowing down to one request every 20 s');
  });

  test('a dropped connection counts as a refusal', async () => {
    const { deps } = harness({ ...SITE });
    const get = deps.get;
    let failures = 0;
    const flaky: CrawlDeps = {
      ...deps,
      get: async (url) => {
        if (url.endsWith('makers.php3') && failures < 1) {
          failures += 1;
          throw new Error('ECONNRESET');
        }
        return get(url);
      },
    };
    expect((await crawlPhoneCatalog(flaky, { ...OPTIONS, phases: ['list'] })).newModels).toBe(3);
  });
});

test('a photo that fails stays pending for the next run without looping now', async () => {
  const { deps, store, gets } = harness({
    ...SITE,
    [`${CDN}/vv/bigpic/m2.jpg`]: { status: 500, retryAfterSeconds: null, body: new Uint8Array() },
  });
  await crawlPhoneCatalog(deps, OPTIONS);
  expect(gets.filter((g) => g.url.endsWith('m2.jpg'))).toHaveLength(1);
  expect(store.models.get(2)!.photoDone).toBe(false);
});

test('robots.txt is honoured', async () => {
  const { deps, gets, store } = harness({
    ...SITE,
    [`${ORIGIN}/robots.txt`]: html('User-agent: *\nDisallow: /samsung_'),
  });
  await crawlPhoneCatalog(deps, OPTIONS);
  expect(gets.some((g) => g.url.includes('samsung_galaxy'))).toBe(false);
  expect(store.models.get(1)).toMatchObject({ detailsDone: true, details: null });
});

test('a robots.txt Crawl-delay slower than ours is kept', async () => {
  const { deps, gets } = harness({
    ...SITE,
    [`${ORIGIN}/robots.txt`]: html('User-agent: *\nCrawl-delay: 30\nDisallow: /search'),
  });
  await crawlPhoneCatalog(deps, { ...OPTIONS, phases: ['list'] });
  for (let i = 2; i < gets.length; i += 1) {
    expect(gets[i]!.at - gets[i - 1]!.at).toBeGreaterThanOrEqual(30_000);
  }
});

test('only the named brands are crawled', async () => {
  const { deps, gets } = harness({ ...SITE });
  await crawlPhoneCatalog(deps, { ...OPTIONS, brands: ['Apple'], phases: ['list'] });
  expect(gets.map((g) => g.url)).toEqual([`${ORIGIN}/robots.txt`, `${ORIGIN}/makers.php3`]);
});
