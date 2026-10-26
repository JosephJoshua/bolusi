// The GSMArena crawl: brands, their model listings, then each model's photo and page.
//
// Polite by design. One request at a time, at least `delayMs` apart plus jitter (the owner chose
// about a second), never faster than a robots.txt Crawl-delay. A 429/503 or a dropped connection
// waits (Retry-After or a growing pause) and doubles the gap between requests for the rest of the
// run, so the crawl settles at a pace GSMArena accepts; a run that keeps being refused stops.
// Everything is saved as it is read, so a stopped run loses nothing and the next one carries on.
//
// A run walks three phases, each resumable from the database:
//   list    — the brand list, then each brand's listing pages. A brand walked to the end before
//             is re-read only until a page brings nothing new (listings are newest first).
//   photos  — the photo of every model that has none yet, newest models first.
//   details — each model's own page, for its maker codes (SM-A556B…), precise year and specs.
import { createHash } from 'node:crypto';

import type { PendingModel, PhoneCatalogWriter } from '@bolusi/db-server';

import {
  BRANDS_PATH,
  GSMARENA_ORIGIN,
  isCrawlablePath,
  isPhotoUrl,
  parseBrandPage,
  parseBrands,
  parseModelPage,
} from './gsmarena.js';
import { RobotsRules } from './robots.js';

export const CRAWL_PHASES = ['list', 'photos', 'details'] as const;
export type CrawlPhase = (typeof CRAWL_PHASES)[number];

export interface CrawlResponse {
  readonly status: number;
  /** Seconds from a Retry-After header, when there was one. */
  readonly retryAfterSeconds: number | null;
  readonly body: Uint8Array;
}

export interface CrawlDeps {
  /** One GET. Rejects only when no response came back at all. */
  readonly get: (url: string) => Promise<CrawlResponse>;
  readonly store: PhoneCatalogWriter;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** In [0, 1). */
  readonly random: () => number;
  readonly log: (line: string) => void;
}

export interface CrawlOptions {
  /** The least time between two requests; each wait adds up to half again at random. */
  readonly delayMs: number;
  /** Brand names to crawl (any case); all brands when absent. */
  readonly brands?: readonly string[];
  /** Stop after this many requests (a short trial run). */
  readonly maxRequests?: number;
  readonly phases?: readonly CrawlPhase[];
  /** Robots user-agent token, matched against robots.txt groups. */
  readonly robotsAgent: string;
}

export interface CrawlSummary {
  readonly requests: number;
  readonly brands: number;
  readonly newModels: number;
  readonly photos: number;
  readonly details: number;
  /** Why the run ended early, if it did. */
  readonly stoppedBy: 'max-requests' | 'refused' | null;
}

/** A pause after a refusal: 5, 10, 20, 40 minutes, capped at an hour. */
const BACKOFF_MS = [5, 10, 20, 40].map((minutes) => minutes * 60_000);
/** The slowest a refused run slows itself to between requests. */
const MAX_DELAY_MS = 60_000;
const MAX_RETRY_AFTER_MS = 60 * 60_000;
const MAX_PHOTO_BYTES = 512 * 1024;
const BATCH = 50;

class StopCrawl extends Error {
  constructor(readonly reason: 'max-requests' | 'refused') {
    super(reason);
  }
}

type Outcome = { kind: 'ok'; body: Uint8Array } | { kind: 'gone' } | { kind: 'failed' };

/** jpeg or png by their magic bytes; anything else is not stored. */
function imageMime(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  return null;
}

export async function crawlPhoneCatalog(
  deps: CrawlDeps,
  options: CrawlOptions,
): Promise<CrawlSummary> {
  const phases = new Set(options.phases ?? CRAWL_PHASES);
  let requests = 0;
  let lastRequestAt: number | null = null;
  let delayMs = options.delayMs;
  const robots = new Map<string, RobotsRules>();
  const counts = { brands: 0, newModels: 0, photos: 0, details: 0 };

  async function paced(url: string): Promise<CrawlResponse> {
    if (options.maxRequests !== undefined && requests >= options.maxRequests) {
      throw new StopCrawl('max-requests');
    }
    if (lastRequestAt !== null) {
      const due = lastRequestAt + delayMs * (1 + deps.random() / 2);
      const wait = due - deps.now();
      if (wait > 0) await deps.sleep(wait);
    }
    requests += 1;
    try {
      return await deps.get(url);
    } finally {
      lastRequestAt = deps.now();
    }
  }

  /** GET with the refusal handling: wait and retry, and give up the run after four refusals. */
  async function fetchPolitely(url: string): Promise<Outcome> {
    for (let attempt = 0; ; attempt += 1) {
      let response: CrawlResponse | null;
      try {
        response = await paced(url);
      } catch (error) {
        if (error instanceof StopCrawl) throw error;
        response = null;
      }
      if (response !== null && response.status >= 200 && response.status < 300) {
        return { kind: 'ok', body: response.body };
      }
      if (response !== null && (response.status === 404 || response.status === 410)) {
        return { kind: 'gone' };
      }
      if (response !== null && response.status !== 429 && response.status !== 503) {
        deps.log(`skip ${url}: HTTP ${response.status}`);
        return { kind: 'failed' };
      }
      if (attempt >= BACKOFF_MS.length) throw new StopCrawl('refused');
      if (delayMs < MAX_DELAY_MS) {
        delayMs = Math.min(delayMs * 2, MAX_DELAY_MS);
        deps.log(`slowing down to one request every ${delayMs / 1000} s`);
      }
      const wait =
        response?.retryAfterSeconds != null
          ? Math.min(response.retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS)
          : BACKOFF_MS[attempt]!;
      deps.log(
        `${response === null ? 'no response' : `HTTP ${response.status}`} for ${url}; waiting ${Math.round(wait / 60_000)} min`,
      );
      await deps.sleep(wait);
    }
  }

  async function allowed(url: string): Promise<boolean> {
    const { origin, pathname, search } = new URL(url);
    let rules = robots.get(origin);
    if (rules === undefined) {
      const outcome = await fetchPolitely(`${origin}/robots.txt`);
      // No robots.txt means no rules; one that cannot be read means stay out for this run.
      rules =
        outcome.kind === 'ok'
          ? RobotsRules.parse(new TextDecoder().decode(outcome.body), options.robotsAgent)
          : outcome.kind === 'gone'
            ? RobotsRules.allowAll()
            : RobotsRules.denyAll();
      robots.set(origin, rules);
      if (rules.crawlDelayMs !== null && rules.crawlDelayMs > delayMs) {
        delayMs = Math.min(rules.crawlDelayMs, MAX_DELAY_MS);
        deps.log(`robots.txt asks for ${delayMs / 1000} s between requests`);
      }
    }
    return rules.allows(pathname + search);
  }

  async function page(path: string): Promise<string | null> {
    if (!isCrawlablePath(path)) return null;
    const url = `${GSMARENA_ORIGIN}/${path}`;
    if (!(await allowed(url))) {
      deps.log(`robots.txt disallows ${url}`);
      return null;
    }
    const outcome = await fetchPolitely(url);
    return outcome.kind === 'ok' ? new TextDecoder().decode(outcome.body) : null;
  }

  async function listPhase(): Promise<void> {
    const html = await page(BRANDS_PATH);
    if (html === null) return;
    await deps.store.saveBrands(parseBrands(html));
    const wanted =
      options.brands === undefined
        ? null
        : new Set(options.brands.map((name) => name.trim().toLowerCase()));
    for (const brand of await deps.store.brands()) {
      if (wanted !== null && !wanted.has(brand.name.toLowerCase())) continue;
      const fullWalk = brand.listedAt === null;
      let path: string | undefined = brand.path;
      let rest: string[] | null = null;
      let complete = true;
      while (path !== undefined) {
        const body = await page(path);
        if (body === null) {
          complete = false;
          break;
        }
        const listing = parseBrandPage(body, brand.name);
        const added = await deps.store.saveListedModels(listing.models, deps.now());
        counts.newModels += added;
        if (!fullWalk && added === 0) break;
        rest ??= listing.pages;
        path = rest.shift();
      }
      counts.brands += 1;
      if (fullWalk && complete) await deps.store.markBrandListed(brand.path, deps.now());
    }
  }

  /**
   * Walk the models `next` hands out. `visit` returns false when it left the model pending (a
   * failed fetch); those are skipped for the rest of this run so none is retried in a loop.
   */
  async function eachPending(
    next: (limit: number) => Promise<PendingModel[]>,
    visit: (model: PendingModel) => Promise<boolean>,
  ): Promise<void> {
    const failed = new Set<number>();
    for (;;) {
      const batch = (await next(BATCH + failed.size)).filter((m) => !failed.has(m.id));
      if (batch.length === 0) return;
      for (const model of batch) if (!(await visit(model))) failed.add(model.id);
    }
  }

  async function photosPhase(): Promise<void> {
    await eachPending(
      (limit) => deps.store.modelsNeedingPhoto(limit),
      async (model) => {
        const url = model.photoUrl;
        if (url === null || !isPhotoUrl(url) || !(await allowed(url))) {
          await deps.store.savePhoto(model.id, null, deps.now());
          return true;
        }
        const outcome = await fetchPolitely(url);
        if (outcome.kind === 'failed') return false;
        const mime = outcome.kind === 'ok' ? imageMime(outcome.body) : null;
        if (outcome.kind === 'gone' || mime === null || outcome.body.length > MAX_PHOTO_BYTES) {
          await deps.store.savePhoto(model.id, null, deps.now());
          return true;
        }
        const sha256 = createHash('sha256').update(outcome.body).digest('hex');
        await deps.store.savePhoto(model.id, { sha256, mime, bytes: outcome.body }, deps.now());
        counts.photos += 1;
        return true;
      },
    );
  }

  async function detailsPhase(): Promise<void> {
    await eachPending(
      (limit) => deps.store.modelsNeedingDetails(limit),
      async (model) => {
        const url = `${GSMARENA_ORIGIN}/${model.pagePath}`;
        if (!isCrawlablePath(model.pagePath) || !(await allowed(url))) {
          await deps.store.saveDetails(model.id, null, deps.now());
          return true;
        }
        const outcome = await fetchPolitely(url);
        if (outcome.kind === 'failed') return false;
        await deps.store.saveDetails(
          model.id,
          outcome.kind === 'gone' ? null : parseModelPage(new TextDecoder().decode(outcome.body)),
          deps.now(),
        );
        counts.details += 1;
        return true;
      },
    );
  }

  let stoppedBy: CrawlSummary['stoppedBy'] = null;
  try {
    if (phases.has('list')) await listPhase();
    if (phases.has('photos')) await photosPhase();
    if (phases.has('details')) await detailsPhase();
  } catch (error) {
    if (!(error instanceof StopCrawl)) throw error;
    stoppedBy = error.reason;
    deps.log(
      error.reason === 'refused'
        ? 'GSMArena keeps refusing; stopping. Run again later to carry on.'
        : 'request budget reached; stopping.',
    );
  }
  return { requests, ...counts, stoppedBy };
}
