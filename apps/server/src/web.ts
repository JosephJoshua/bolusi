// The web app (apps/web) served from this server, so one deployment answers the slip's QR link,
// the page, and the API it reads. Set WEB_DIR to the app's build (apps/web/dist); unset, the server
// serves the API only.
//
// Built assets carry a content hash in their name and are cached for good; every other path gets
// index.html (the app picks its page by path, e.g. /c/<code>), never cached, so a new build reaches
// customers on their next visit. API and handoff paths are never answered here.
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from './env.js';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

const PAGE_HEADERS = {
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
} as const;

function isApi(path: string): boolean {
  return path === '/v1' || path.startsWith('/v1/') || path === '/h' || path.startsWith('/h/');
}

/** The file under `root` a request path names, or null for anything that would leave it. */
function fileUnder(root: string, path: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const file = normalize(join(root, decoded));
  return file.startsWith(root.endsWith(sep) ? root : root + sep) ? file : null;
}

async function readOrNull(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

export function webSite(dir: string): MiddlewareHandler<AppEnv> {
  const root = normalize(dir);
  return async (c, next) => {
    const method = c.req.method;
    if ((method !== 'GET' && method !== 'HEAD') || isApi(c.req.path)) {
      await next();
      return;
    }
    const asset = c.req.path.startsWith('/assets/') ? fileUnder(root, c.req.path) : null;
    const assetBytes = asset === null ? null : await readOrNull(asset);
    if (asset !== null && assetBytes !== null) {
      c.header('Content-Type', TYPES[extname(asset)] ?? 'application/octet-stream');
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
      c.header('X-Content-Type-Options', 'nosniff');
      return c.body(new Uint8Array(assetBytes));
    }
    if (c.req.path.startsWith('/assets/')) {
      await next();
      return;
    }
    const page = await readOrNull(join(root, 'index.html'));
    if (page === null) {
      await next();
      return;
    }
    for (const [name, value] of Object.entries(PAGE_HEADERS)) c.header(name, value);
    c.header('Content-Type', TYPES['.html']);
    return c.body(new Uint8Array(page));
  };
}
