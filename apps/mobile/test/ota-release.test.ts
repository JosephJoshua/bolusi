// The phone update release: each manifest is signed exactly as phones will receive it, and lists
// every file by the hash phones check it against, at the URL the release serves it from.
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { buildPlatformUpdate } from '../scripts/ota-release.mjs';

const BASE = 'https://github.com/acme/shop/releases/download/mobile-ota-7';

function exportDir(): { dist: string; metadata: unknown } {
  const dist = mkdtempSync(join(tmpdir(), 'ota-'));
  mkdirSync(join(dist, '_expo/static/js/android'), { recursive: true });
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, '_expo/static/js/android/index-abc.hbc'), 'bytecode');
  writeFileSync(join(dist, 'assets/f00d'), 'font bytes');
  return {
    dist,
    metadata: {
      version: 0,
      bundler: 'metro',
      fileMetadata: {
        android: {
          bundle: '_expo/static/js/android/index-abc.hbc',
          assets: [{ path: 'assets/f00d', ext: 'ttf' }],
        },
      },
    },
  };
}

describe('building a phone update', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { dist, metadata } = exportDir();
  const built = buildPlatformUpdate({
    distDir: dist,
    metadata,
    platform: 'android',
    runtimeVersion: 'fp-1',
    expoConfig: { name: 'Bolusi', slug: 'bolusi' },
    baseUrl: BASE,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    id: '0b6d4a5e-8a51-4c6e-9d1f-2f3a4b5c6d7e',
    createdAt: '2026-10-28T00:00:00.000Z',
  }) as {
    file: { runtimeVersion: string; manifest: string; signature: string };
    copies: { from: string; name: string }[];
  };

  test('the signature verifies over the exact manifest text, in the header shape phones read', () => {
    const match = /^sig="([A-Za-z0-9+/=]+)", keyid="main"$/.exec(built.file.signature);
    expect(match).not.toBeNull();
    const signature = Buffer.from(match![1]!, 'base64');
    expect(verify('sha256', Buffer.from(built.file.manifest), publicKey, signature)).toBe(true);
    expect(verify('sha256', Buffer.from(`${built.file.manifest} `), publicKey, signature)).toBe(
      false,
    );
  });

  test('every file is listed by its SHA-256 and served from the release under that name', () => {
    const manifest = JSON.parse(built.file.manifest) as {
      runtimeVersion: string;
      launchAsset: { hash: string; url: string; contentType: string };
      assets: { hash: string; url: string; contentType: string; fileExtension: string }[];
      extra: { expoClient: unknown };
    };
    const hex = (text: string) => createHash('sha256').update(text).digest('hex');
    const b64 = (text: string) => createHash('sha256').update(text).digest('base64url');
    expect(manifest.runtimeVersion).toBe('fp-1');
    expect(manifest.launchAsset).toMatchObject({
      hash: b64('bytecode'),
      url: `${BASE}/${hex('bytecode')}.bundle`,
      contentType: 'application/javascript',
    });
    expect(manifest.assets).toEqual([
      expect.objectContaining({
        hash: b64('font bytes'),
        url: `${BASE}/${hex('font bytes')}.ttf`,
        contentType: 'font/ttf',
        fileExtension: '.ttf',
      }),
    ]);
    expect(manifest.extra.expoClient).toEqual({ name: 'Bolusi', slug: 'bolusi' });
    expect(built.copies.map((copy) => copy.name)).toEqual([
      `${hex('bytecode')}.bundle`,
      `${hex('font bytes')}.ttf`,
    ]);
    expect(readFileSync(built.copies[0]!.from, 'utf8')).toBe('bytecode');
  });
});
