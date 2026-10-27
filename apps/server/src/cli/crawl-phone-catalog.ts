// Crawl GSMArena into the phone catalog (catalog/crawl.ts). Run it by hand or from a scheduler;
// each run carries on from where the last one stopped.
//
//   DATABASE_URL=<owner URL> pnpm --filter @bolusi/server crawl-phone-catalog [options]
//
// It writes the catalog tables, which only their owner (bolusi_provision) may change, so it
// connects with that role's URL, not the app's.
import {
  CRAWL_PHASES,
  crawlPhoneCatalog,
  type CrawlDeps,
  type CrawlOptions,
  type CrawlPhase,
} from '../catalog/crawl.js';

/** Never faster than this, whatever is asked: one request at a time, at most one a second. */
const MIN_DELAY_SECONDS = 1;
const DEFAULT_DELAY_SECONDS = 1;
const ROBOTS_AGENT = 'BolusiCatalog';
const USER_AGENT = `${ROBOTS_AGENT}/1.0 (phone repair shop software; about one request a second)`;

const USAGE = `crawl-phone-catalog [--delay-seconds N] [--brands "Samsung,Apple"] [--max-requests N] [--phases list,photos,details]

  --delay-seconds  least time between requests (default ${DEFAULT_DELAY_SECONDS}, at least ${MIN_DELAY_SECONDS})
  --brands         only these brands, by name
  --max-requests   stop after this many requests (a trial run)
  --phases         which phases to run (default all, in order)
`;

export function parseCrawlArgs(args: readonly string[]): CrawlOptions {
  const read = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`);
    if (at < 0) return undefined;
    const value = args[at + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    return value;
  };
  const known = new Set(['--delay-seconds', '--brands', '--max-requests', '--phases']);
  for (const arg of args) {
    if (arg.startsWith('--') && !known.has(arg)) throw new Error(`unknown option ${arg}`);
  }
  const delaySeconds = Number(read('delay-seconds') ?? DEFAULT_DELAY_SECONDS);
  if (!Number.isFinite(delaySeconds) || delaySeconds < MIN_DELAY_SECONDS) {
    throw new Error(`--delay-seconds must be at least ${MIN_DELAY_SECONDS}`);
  }
  const brands = read('brands');
  const maxRequests = read('max-requests');
  const phases = read('phases');
  const phaseList = phases?.split(',').map((p) => p.trim());
  for (const phase of phaseList ?? []) {
    if (!(CRAWL_PHASES as readonly string[]).includes(phase)) {
      throw new Error(`unknown phase ${phase}`);
    }
  }
  if (maxRequests !== undefined && !(Number(maxRequests) > 0)) {
    throw new Error('--max-requests must be a positive number');
  }
  return {
    delayMs: delaySeconds * 1000,
    robotsAgent: ROBOTS_AGENT,
    ...(brands === undefined ? {} : { brands: brands.split(',').filter((b) => b.trim() !== '') }),
    ...(maxRequests === undefined ? {} : { maxRequests: Number(maxRequests) }),
    ...(phaseList === undefined ? {} : { phases: phaseList as CrawlPhase[] }),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.includes('--help')) {
    process.stdout.write(USAGE);
    return;
  }
  let options: CrawlOptions;
  try {
    options = parseCrawlArgs(args);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  const { createPhoneCatalogWriter } = await import('@bolusi/db-server');
  const deps: CrawlDeps = {
    store: createPhoneCatalogWriter(),
    get: async (url) => {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        // A redirect would lead past the robots.txt check and the path rules; it is skipped instead.
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
      });
      const retryAfter = Number(response.headers.get('retry-after'));
      return {
        status: response.status,
        retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
        body: new Uint8Array(await response.arrayBuffer()),
      };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    random: Math.random,
    log: (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`),
  };
  const summary = await crawlPhoneCatalog(deps, options);
  deps.log(
    `done: ${summary.requests} requests, ${summary.brands} brands, ${summary.newModels} new models, ${summary.photos} photos, ${summary.details} model pages`,
  );
  process.exit(summary.stoppedBy === 'refused' ? 1 : 0);
}

if (
  process.argv[1]?.endsWith('crawl-phone-catalog.ts') ||
  process.argv[1]?.endsWith('crawl-phone-catalog.js')
) {
  void main();
}
