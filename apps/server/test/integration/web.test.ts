// The web app at the site root (web.ts): built assets cached for good, every other page path gets
// index.html never cached, nothing outside the build is reachable, and the API is untouched.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { makeTestApp } from '../helpers/app.js';

function build(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bolusi-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Bolusi</title>');
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(join(dir, '..', 'secret.txt'), 'not for the web');
  return dir;
}

describe('the web app', () => {
  test('a status link gets the page, not cached and not indexed', async () => {
    const { app } = makeTestApp({ webDir: build() });

    for (const path of ['/c/K7M2Q9XA4BRS', '/C/K7M2-Q9XA-4BRS', '/']) {
      const res = await app.request(`http://srv.test${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('x-robots-tag')).toBe('noindex');
      expect(await res.text()).toContain('<title>Bolusi</title>');
    }
  });

  test('a link code, the page’s only credential, never reaches the access log', async () => {
    const { app, accessLogs } = makeTestApp({ webDir: build() });

    for (const path of ['/c/K7M2Q9XA4BRS', '/C/K7M2-Q9XA-4BRS', '/v1/public/status/K7M2Q9XA4BRS']) {
      await app.request(`http://srv.test${path}`);
    }

    expect(accessLogs.map((log) => log.path)).toEqual([
      '/c/:code',
      '/c/:code',
      '/v1/public/status/:code',
    ]);
  });

  test('built assets are cached for good; a missing one is a 404', async () => {
    const { app } = makeTestApp({ webDir: build() });

    const js = await app.request('http://srv.test/assets/index-abc123.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    expect((await app.request('http://srv.test/assets/gone.js')).status).toBe(404);
  });

  test('nothing outside the build is served', async () => {
    const { app } = makeTestApp({ webDir: build() });

    for (const path of ['/assets/../../secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt']) {
      const res = await app.request(`http://srv.test${path}`);
      expect(await res.text(), path).not.toContain('not for the web');
    }
  });

  test('the API keeps its own answers, and without a build there is no site', async () => {
    const { app } = makeTestApp({ webDir: build() });
    const res = await app.request('http://srv.test/v1/nope');
    expect(res.status).toBe(401);

    const apiOnly = makeTestApp().app;
    expect((await apiOnly.request('http://srv.test/c/K7M2Q9XA4BRS')).status).toBe(404);
  });
});
