// Reading GSMArena's pages: the brand list, a brand's model listing, and one model's page.
//
// Pure functions over HTML text, kept apart from the crawl (crawl.ts) so they can be checked
// against saved pages. They read the few stable hooks GSMArena's markup has (`div.makers`,
// `data-spec="models"`, ...) with tolerant patterns, and accept only paths and photo hosts of the
// expected shape, so a changed or hostile page can make the crawl find nothing but never makes it
// fetch somewhere else.
import type { ListedPhoneModel, PhoneModelDetails, PhoneModelKind } from '@bolusi/db-server';
import { PHONE_SPEC_MAX_LENGTH, type PhoneSpecKey, type PhoneSpecs } from '@bolusi/schemas';

export const GSMARENA_ORIGIN = 'https://www.gsmarena.com';
export const BRANDS_PATH = 'makers.php3';

/** Photos are served from GSMArena's own image hosts only. */
const PHOTO_HOST = /^https:\/\/fdn\d*\.gsmarena\.com\//;
const BRAND_PATH = /^[a-z0-9_]+-phones-\d+\.php$/;
const BRAND_PAGE_PATH = /^[a-z0-9_]+-phones-f-\d+-\d+-p\d+\.php$/;
const MODEL_PATH = /^[a-z0-9_]+-(\d+)\.php$/;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Visible text of an HTML fragment: tags dropped, `<br>` read as a space, whitespace collapsed. */
function textOf(html: string): string {
  return decode(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** An attribute's value, quoted or not. */
function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (match === null) return null;
  return decode(match[1] ?? match[2] ?? match[3] ?? '');
}

/** The inside of the first `<div class="...name...">`, up to the next one at the same depth. */
function section(html: string, className: string): string | null {
  const open = new RegExp(`<div[^>]*class\\s*=\\s*["']?[^"'>]*\\b${className}\\b[^>]*>`, 'i').exec(
    html,
  );
  if (open === null) return null;
  let depth = 1;
  const tags = /<(\/?)div\b[^>]*>/gi;
  tags.lastIndex = open.index + open[0].length;
  for (let tag = tags.exec(html); tag !== null; tag = tags.exec(html)) {
    depth += tag[1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(open.index + open[0].length, tag.index);
  }
  return html.slice(open.index + open[0].length);
}

function photoUrl(value: string | null): string | null {
  return value !== null && PHOTO_HOST.test(value) ? value : null;
}

export interface ListedBrand {
  readonly path: string;
  readonly name: string;
}

/** The brands on `makers.php3`. */
export function parseBrands(html: string): ListedBrand[] {
  const out = new Map<string, ListedBrand>();
  const scope = section(html, 'st-text') ?? html;
  for (const match of scope.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const path = attribute(match[1]!, 'href');
    if (path === null || !BRAND_PATH.test(path)) continue;
    // "Samsung<br><span>1381 devices</span>": the name is what comes before the count.
    const name = textOf(match[2]!.replace(/<span[\s\S]*?<\/span>/gi, ''));
    if (name !== '' && !out.has(path)) out.set(path, { path, name });
  }
  return [...out.values()];
}

/** Phone unless the listing says tablet or watch. */
export function kindFromTitle(title: string): PhoneModelKind {
  if (/\btablet\b/i.test(title)) return 'tablet';
  if (/\b(smart)?watch\b/i.test(title)) return 'watch';
  return 'phone';
}

/** "... Announced Mar 2024. ..." → 2024. */
export function yearFromTitle(title: string): number | null {
  const match = /\bAnnounced\s+(?:[A-Za-z]+\.?\s+)?((?:19|20)\d{2})\b/.exec(title);
  return match === null ? null : Number(match[1]);
}

export interface BrandPage {
  readonly models: ListedPhoneModel[];
  /** The other listing pages of this brand, in page order. */
  readonly pages: string[];
}

/** One listing page of a brand: its models and the links to its other pages. */
export function parseBrandPage(html: string, brand: string): BrandPage {
  const models: ListedPhoneModel[] = [];
  const seen = new Set<number>();
  const scope = section(html, 'makers') ?? '';
  for (const item of scope.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const body = item[1]!;
    const link = /<a\b([^>]*)>/i.exec(body);
    const pagePath = link === null ? null : attribute(link[1]!, 'href');
    const id = pagePath === null ? null : MODEL_PATH.exec(pagePath)?.[1];
    if (pagePath === null || id === undefined || id === null) continue;
    const img = /<img\b([^>]*)>/i.exec(body);
    const title = img === null ? '' : (attribute(img[1]!, 'title') ?? '');
    const span = /<span\b[^>]*>([\s\S]*?)<\/span>/i.exec(body);
    const name = textOf(span?.[1] ?? body);
    const numericId = Number(id);
    if (name === '' || seen.has(numericId)) continue;
    seen.add(numericId);
    models.push({
      id: numericId,
      brand,
      name,
      kind: kindFromTitle(title),
      announcedYear: yearFromTitle(title),
      pagePath,
      photoUrl: photoUrl(img === null ? null : attribute(img[1]!, 'src')),
    });
  }

  const pages: string[] = [];
  const nav = section(html, 'nav-pages') ?? '';
  for (const match of nav.matchAll(/<a\b([^>]*)>/gi)) {
    const path = attribute(match[1]!, 'href');
    if (path !== null && BRAND_PAGE_PATH.test(path) && !pages.includes(path)) pages.push(path);
  }
  pages.sort((a, b) => pageNumber(a) - pageNumber(b));
  return { models, pages };
}

function pageNumber(path: string): number {
  return Number(/-p(\d+)\.php$/.exec(path)?.[1] ?? 0);
}

function spec(html: string, name: string): string | null {
  const match = new RegExp(
    `<(td|div|span|a)\\b[^>]*data-spec\\s*=\\s*["']?${name}(?=["'\\s>])["']?[^>]*>([\\s\\S]*?)</\\1>`,
    'i',
  ).exec(html);
  return match === null ? null : textOf(match[2]!);
}

/** A spec row found by its label ("Charging"), for the rows GSMArena gives no `data-spec`. */
function labelledSpec(html: string, label: string): string | null {
  const match = new RegExp(
    `<td[^>]*class\\s*=\\s*["']?ttl["']?[^>]*>(?:\\s*<a\\b[^>]*>)?\\s*${label}\\s*(?:</a>\\s*)?</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`,
    'i',
  ).exec(html);
  return match === null ? null : textOf(match[1]!);
}

/** Where each kept spec is on the page, and how much of it to keep. */
const SPEC_SOURCES: readonly {
  readonly key: PhoneSpecKey;
  readonly read: (html: string) => string | null;
  /** Keep only what comes before the first comma ("6.7 inches, 110.2 cm2 (...)" → "6.7 inches"). */
  readonly head?: true;
}[] = [
  { key: 'displayType', read: (html) => spec(html, 'displaytype') },
  { key: 'displaySize', read: (html) => spec(html, 'displaysize'), head: true },
  { key: 'displayResolution', read: (html) => spec(html, 'displayresolution'), head: true },
  { key: 'os', read: (html) => spec(html, 'os'), head: true },
  { key: 'chipset', read: (html) => spec(html, 'chipset') },
  { key: 'internalMemory', read: (html) => spec(html, 'internalmemory') },
  { key: 'cardSlot', read: (html) => spec(html, 'memoryslot') },
  { key: 'battery', read: (html) => spec(html, 'batdescription1'), head: true },
  { key: 'charging', read: (html) => labelledSpec(html, 'Charging') },
  { key: 'usb', read: (html) => spec(html, 'usb') },
  { key: 'sim', read: (html) => spec(html, 'sim') },
  { key: 'colors', read: (html) => spec(html, 'colors') },
];

function clip(text: string): string {
  return text.length <= PHONE_SPEC_MAX_LENGTH
    ? text
    : `${text.slice(0, PHONE_SPEC_MAX_LENGTH - 1).trimEnd()}…`;
}

/** The specs a model page gives (see `PHONE_SPEC_KEYS`); a missing or empty cell is left out. */
export function parseSpecs(html: string): PhoneSpecs {
  const specs: PhoneSpecs = {};
  for (const source of SPEC_SOURCES) {
    let text = source.read(html);
    if (text !== null && source.head === true) text = text.split(',')[0]!.trim();
    // GSMArena writes "No" for a missing card slot; that is information. "-" or "" is not.
    if (text !== null && text !== '' && text !== '-') specs[source.key] = clip(text);
  }
  return specs;
}

/** What a model's own page adds to the listing: its maker codes, the precise year and specs. */
export function parseModelPage(html: string): PhoneModelDetails {
  const codes = (spec(html, 'models') ?? '')
    .split(/[,;]/)
    .map((code) => code.trim())
    .filter((code) => code !== '' && code.length <= 40);
  const year = /\b((?:19|20)\d{2})\b/.exec(spec(html, 'year') ?? '');
  return {
    modelCodes: [...new Set(codes)],
    announcedYear: year === null ? null : Number(year[1]),
    specs: parseSpecs(html),
  };
}

/** Whether `path` is a page this crawl may fetch from GSMArena. */
export function isCrawlablePath(path: string): boolean {
  return (
    path === BRANDS_PATH ||
    BRAND_PATH.test(path) ||
    BRAND_PAGE_PATH.test(path) ||
    MODEL_PATH.test(path)
  );
}

export function isPhotoUrl(url: string): boolean {
  return PHOTO_HOST.test(url);
}
