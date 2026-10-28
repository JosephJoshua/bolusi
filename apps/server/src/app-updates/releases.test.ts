// Phones get the newest signed update made for their own native build, byte for byte, and are told
// "nothing newer" when there is none. GitHub is faked; nothing here touches the network.
import { describe, expect, it, vi } from 'vitest';

import { createAppUpdatesRouter } from '../routes/app-updates.js';

import { gitHubReleaseSource, type UpdateSource } from './releases.js';

const REPO = 'acme/shop';
const ID_NEW = '0b6d4a5e-8a51-4c6e-9d1f-2f3a4b5c6d7e';
const ID_OLD = '1c7e5b6f-9b62-4d7f-8e2a-3a4b5c6d7e8f';

function manifest(id: string, runtimeVersion: string): string {
  return JSON.stringify({ id, createdAt: '2026-10-28T00:00:00.000Z', runtimeVersion });
}

function update(id: string, runtimeVersion: string) {
  return {
    runtimeVersion,
    manifest: manifest(id, runtimeVersion),
    signature: `sig="c2ln${id.slice(0, 4)}", keyid="main"`,
  };
}

interface FakeGitHub {
  readonly fetch: typeof fetch;
  readonly calls: string[];
}

/** Releases newest first, as GitHub lists them; each asset URL serves its JSON. */
function fakeGitHub(
  releases: { tag: string; draft?: boolean; files: Record<string, unknown> }[],
  status = 200,
): FakeGitHub {
  const calls: string[] = [];
  const assets = new Map<string, unknown>();
  const listing = releases.map((release) => ({
    tag_name: release.tag,
    draft: release.draft ?? false,
    assets: Object.entries(release.files).map(([name, body]) => {
      const url = `https://github.com/${REPO}/releases/download/${release.tag}/${name}`;
      assets.set(url, body);
      return { name, browser_download_url: url };
    }),
  }));
  const fake = vi.fn((input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('https://api.github.com/')) {
      return Promise.resolve(new Response(JSON.stringify(listing), { status }));
    }
    const body = assets.get(url);
    return Promise.resolve(
      body === undefined
        ? new Response('missing', { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 }),
    );
  });
  return { fetch: fake as unknown as typeof fetch, calls };
}

describe('picking the update for a phone', () => {
  const github = (): FakeGitHub =>
    fakeGitHub([
      { tag: 'desktop-v0.3.0', files: { 'latest.yml': 'x' } },
      { tag: 'mobile-ota-3', draft: true, files: { 'ota-android.json': update(ID_NEW, 'fp-b') } },
      {
        tag: 'mobile-ota-2',
        files: {
          'ota-android.json': update(ID_NEW, 'fp-b'),
          'ota-ios.json': update(ID_NEW, 'i-b'),
        },
      },
      { tag: 'mobile-ota-1', files: { 'ota-android.json': update(ID_OLD, 'fp-a') } },
    ]);

  it('gives the newest published update made for the same native build', async () => {
    const source = gitHubReleaseSource({ repo: REPO, fetch: github().fetch });
    expect(await source.latest('android', 'fp-b')).toEqual({
      id: ID_NEW,
      manifest: manifest(ID_NEW, 'fp-b'),
      signature: update(ID_NEW, 'fp-b').signature,
    });
  });

  it('a phone on an older native build gets the last update made for it, never a newer one', async () => {
    const source = gitHubReleaseSource({ repo: REPO, fetch: github().fetch });
    expect((await source.latest('android', 'fp-a'))?.id).toBe(ID_OLD);
  });

  it('nothing for a native build no update was made for', async () => {
    const source = gitHubReleaseSource({ repo: REPO, fetch: github().fetch });
    expect(await source.latest('android', 'fp-z')).toBeNull();
  });

  it('asks GitHub for the list at most every few minutes and for each file once', async () => {
    let now = 0;
    const fake = github();
    const source = gitHubReleaseSource({ repo: REPO, fetch: fake.fetch, now: () => now });
    await source.latest('android', 'fp-b');
    await source.latest('android', 'fp-b');
    now += 4 * 60_000;
    await source.latest('android', 'fp-b');
    expect(fake.calls.filter((url) => url.includes('api.github.com'))).toHaveLength(1);
    now += 2 * 60_000;
    await source.latest('android', 'fp-b');
    expect(fake.calls.filter((url) => url.includes('api.github.com'))).toHaveLength(2);
    expect(fake.calls.filter((url) => url.endsWith('mobile-ota-2/ota-android.json'))).toHaveLength(
      1,
    );
  });

  it('a GitHub failure is not cached, so the next phone tries again', async () => {
    const down = fakeGitHub([], 502);
    const source = gitHubReleaseSource({ repo: REPO, fetch: down.fetch });
    await expect(source.latest('android', 'fp-b')).rejects.toThrow('502');
    await expect(source.latest('android', 'fp-b')).rejects.toThrow('502');
    expect(down.calls).toHaveLength(2);
  });

  it('skips a malformed update file instead of failing every phone', async () => {
    const fake = fakeGitHub([
      { tag: 'mobile-ota-2', files: { 'ota-android.json': { runtimeVersion: 'fp-b' } } },
      {
        tag: 'mobile-ota-1',
        files: { 'ota-android.json': { ...update(ID_OLD, 'fp-b'), manifest: '{not json' } },
      },
      { tag: 'mobile-ota-0', files: { 'ota-android.json': update(ID_OLD, 'fp-b') } },
    ]);
    const source = gitHubReleaseSource({ repo: REPO, fetch: fake.fetch });
    expect((await source.latest('android', 'fp-b'))?.id).toBe(ID_OLD);
  });
});

describe('GET /updates/manifest', () => {
  const ask = (source: UpdateSource | undefined, headers: Record<string, string>) =>
    createAppUpdatesRouter(source).request('/manifest', { headers });
  const phone = { 'expo-platform': 'android', 'expo-runtime-version': 'fp-b' };
  const source: UpdateSource = {
    latest: (platform, runtime) =>
      Promise.resolve(
        platform === 'android' && runtime === 'fp-b'
          ? { id: ID_NEW, manifest: manifest(ID_NEW, 'fp-b'), signature: 'sig="abc", keyid="main"' }
          : null,
      ),
  };

  it('hands over the signed manifest byte for byte', async () => {
    const response = await ask(source, phone);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(manifest(ID_NEW, 'fp-b'));
    expect(response.headers.get('expo-signature')).toBe('sig="abc", keyid="main"');
    expect(response.headers.get('expo-protocol-version')).toBe('1');
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('says nothing newer to a phone already running it', async () => {
    const response = await ask(source, { ...phone, 'expo-current-update-id': ID_NEW });
    expect(response.status).toBe(204);
    expect(response.headers.get('expo-protocol-version')).toBe('1');
  });

  it('says nothing newer when no update fits, or no store is set up', async () => {
    expect((await ask(source, { ...phone, 'expo-runtime-version': 'fp-z' })).status).toBe(204);
    expect((await ask(undefined, phone)).status).toBe(204);
  });

  it('refuses a request that is not from the app', async () => {
    expect((await ask(source, { 'expo-runtime-version': 'fp-b' })).status).toBe(400);
    expect((await ask(source, { ...phone, 'expo-platform': 'web' })).status).toBe(400);
    expect((await ask(source, { ...phone, 'expo-runtime-version': '../x y' })).status).toBe(400);
  });

  it('answers 503 when GitHub is unreachable, so the phone keeps what it runs', async () => {
    const broken: UpdateSource = { latest: () => Promise.reject(new Error('offline')) };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await ask(broken, phone)).status).toBe(503);
  });
});
