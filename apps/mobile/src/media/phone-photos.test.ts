// Phone model photos for the intake screen: a downloaded photo is kept only when it hashes to what
// the catalog row says, a kept one is never downloaded again, and rows showing the same photo at
// once share one download.
import { describe, expect, test } from 'vitest';

import { bytesOfLength, sha256Hex } from './_harness.test.js';
import { createPhonePhotoLoader, type PhonePhotoFiles } from './phone-photos.js';

const BYTES = bytesOfLength(256);
const PHOTO = { modelId: 12824, sha256: sha256Hex(BYTES) } as const;

function rig(
  options: { body?: Uint8Array<ArrayBuffer>; status?: number; token?: string | null } = {},
) {
  const stored = new Map<string, Uint8Array>();
  const files: PhonePhotoFiles = {
    find: (name) => (stored.has(name) ? `file:///cache/${name}` : null),
    write: (name, bytes) => {
      stored.set(name, bytes);
      return `file:///cache/${name}`;
    },
  };
  const requests: { url: string; auth: string | null }[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    requests.push({ url, auth: new Headers(init?.headers).get('Authorization') });
    const body = options.body ?? BYTES;
    return Promise.resolve(new Response(body, { status: options.status ?? 200 }));
  }) as typeof fetch;
  const load = createPhonePhotoLoader({
    baseUrl: 'https://api.example',
    deviceToken: () => Promise.resolve(options.token === undefined ? 'tok' : options.token),
    sha256Hex,
    files,
    fetchImpl,
  });
  return { load, stored, requests };
}

describe('phone photo loader', () => {
  test('downloads the photo once, with the device token, and keeps it under its hash', async () => {
    const { load, stored, requests } = rig();
    const uri = await load(PHOTO);
    expect(uri).toBe(`file:///cache/12824-${PHOTO.sha256}`);
    expect(requests).toEqual([
      { url: 'https://api.example/v1/catalog/phones/12824/photo', auth: 'Bearer tok' },
    ]);
    expect(stored.get(`12824-${PHOTO.sha256}`)).toEqual(BYTES);

    expect(await load(PHOTO)).toBe(uri);
    expect(requests).toHaveLength(1);
  });

  test('rejects a download whose bytes do not match the catalog hash', async () => {
    const { load, stored } = rig({ body: bytesOfLength(255) });
    expect(await load(PHOTO)).toBeNull();
    expect(stored.size).toBe(0);
  });

  test('rows showing the same photo at once share one download', async () => {
    const { load, requests } = rig();
    const [a, b, c] = await Promise.all([load(PHOTO), load(PHOTO), load(PHOTO)]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(requests).toHaveLength(1);
  });

  test('a failed download is retried the next time the photo is shown', async () => {
    const failing = rig({ status: 503 });
    expect(await failing.load(PHOTO)).toBeNull();
    expect(await failing.load(PHOTO)).toBeNull();
    expect(failing.requests).toHaveLength(2);
  });

  test('without a device token, or with a malformed ref, nothing is fetched', async () => {
    const signedOut = rig({ token: null });
    expect(await signedOut.load(PHOTO)).toBeNull();
    expect(signedOut.requests).toHaveLength(0);

    const { load, requests } = rig();
    expect(await load({ modelId: 1.5, sha256: PHOTO.sha256 })).toBeNull();
    expect(await load({ modelId: 1, sha256: '../../etc' })).toBeNull();
    expect(requests).toHaveLength(0);
  });
});
