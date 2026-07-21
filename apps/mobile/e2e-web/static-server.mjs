// Minimal dependency-free static file server for the exported web bundle (task 116).
//
// `expo export --platform web` produces a static SPA under `dist/`: `index.html`, the hashed
// `_expo/static/**` JS/asset files, and a font. The Playwright visual suite serves it here rather
// than pulling in an npm static-server dep (08 §2.1 keeps the dep set minimal). It is a browser
// APPROXIMATION harness, never a production server — no caching, no compression, no security
// posture; it exists only to feed the headless browser the RNW build.
//
// SPA fallback: any path that is not a real file falls back to index.html, so `/?screen=pin` (the
// harness reads its target from the query string, not the path) still serves the app shell.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const root = process.argv[2] ?? 'dist';
const port = Number(process.env['PORT'] ?? 4599);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  // Strip the leading slash and normalize away any `..` so a request can never escape `root`.
  const rel = normalize(decodeURIComponent(url.pathname))
    .replace(/^(\.\.[/\\])+/, '')
    .replace(/^[/\\]+/, '');
  let filePath = join(root, rel);

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // SPA fallback — serve index.html for unknown paths (the harness routes via ?screen=…).
    filePath = join(root, 'index.html');
  }
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }

  res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
});

server.listen(port, () => {
  // Printed so `playwright.config` (which spawns this) and a human running it both see the URL.
  console.log(`[static-server] serving ${root} at http://localhost:${port}`);
});
