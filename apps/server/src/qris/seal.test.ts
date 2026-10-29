import { describe, expect, test } from 'vitest';

import { createSecretSealer } from './seal.js';

const KEY = Buffer.alloc(32, 1).toString('base64');

describe('sealing a provider key', () => {
  test('opens to the same key, under the same row only', () => {
    const sealer = createSecretSealer(KEY);
    const sealed = sealer.seal('xnd_development_secret', 'qris:t1:a1');
    expect(sealed).not.toContain('secret');
    expect(sealer.open(sealed, 'qris:t1:a1')).toBe('xnd_development_secret');
    expect(() => sealer.open(sealed, 'qris:t1:a2')).toThrow();
  });

  test('a sealed key does not open under another server key, or once altered', () => {
    const sealed = createSecretSealer(KEY).seal('xnd_development_secret', 'ctx');
    expect(() =>
      createSecretSealer(Buffer.alloc(32, 2).toString('base64')).open(sealed, 'ctx'),
    ).toThrow();
    const [version, iv, body] = sealed.split('.') as [string, string, string];
    const flipped = Buffer.from(body, 'base64');
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() =>
      createSecretSealer(KEY).open(`${version}.${iv}.${flipped.toString('base64')}`, 'ctx'),
    ).toThrow();
  });

  test('refuses a server key that is not 32 bytes', () => {
    expect(() => createSecretSealer(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
