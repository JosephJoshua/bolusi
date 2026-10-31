// MEDIA_STORAGE_DIR: required to boot, and the test-only fallback is never a fixed shared path.
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { requireMediaStorageDir, resolveMediaStorageDir } from './config.js';

describe('media storage directory', () => {
  test('the server refuses to boot without MEDIA_STORAGE_DIR', () => {
    expect(() => requireMediaStorageDir({})).toThrow(/MEDIA_STORAGE_DIR is not set/);
    expect(() => requireMediaStorageDir({ MEDIA_STORAGE_DIR: '' })).toThrow(/MEDIA_STORAGE_DIR/);
    expect(() => requireMediaStorageDir({ MEDIA_STORAGE_DIR: '/srv/media' })).not.toThrow();
  });

  test('a set MEDIA_STORAGE_DIR is used as is', () => {
    expect(resolveMediaStorageDir({ MEDIA_STORAGE_DIR: '/srv/media' })).toBe('/srv/media');
  });

  test('the unset fallback is a fresh unguessable path, not a shared predictable one', () => {
    const a = resolveMediaStorageDir({});
    const b = resolveMediaStorageDir({});
    expect(a).not.toBe(b);
    expect(a).not.toBe(path.join(os.tmpdir(), 'bolusi-media-v0'));
    expect(path.dirname(a)).toBe(os.tmpdir());
  });
});
