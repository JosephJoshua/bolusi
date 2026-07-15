// Unit tests for LocalDiskBlobStore (api/03-media §6). The path-traversal defense is part of
// SEC-MEDIA-04: a key with `..`, an absolute/drive segment, a backslash, or a NUL is refused, and a
// blob only ever lands under the server-generated root. Round-trip + atomic-overwrite are also pinned.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LocalDiskBlobStore, UnsafeBlobKeyError, mediaStorageKey } from './blob-store.js';

let root: string;
let store: LocalDiskBlobStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bolusi-blob-test-'));
  store = new LocalDiskBlobStore(root);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('round-trip + write-once semantics', () => {
  test('put → exists → getStream → delete', async () => {
    const key = mediaStorageKey(
      '11111111-1111-7111-8111-111111111111',
      '22222222-2222-7222-8222-222222222222',
    );
    const data = Uint8Array.from([1, 2, 3, 4, 5]);
    await store.put(key, data);
    expect(await store.exists(key)).toBe(true);
    const chunks: Uint8Array[] = [];
    const reader = (await store.getStream(key)).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect([...Buffer.concat(chunks.map((c) => Buffer.from(c)))]).toEqual([1, 2, 3, 4, 5]);
    await store.delete(key);
    expect(await store.exists(key)).toBe(false);
  });

  test('put overwrites the same key atomically (idempotent complete)', async () => {
    const key = mediaStorageKey(
      'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
    );
    await store.put(key, Uint8Array.from([9, 9]));
    await store.put(key, Uint8Array.from([1, 2, 3]));
    const abs = path.join(root, key);
    expect([...(await fs.readFile(abs))]).toEqual([1, 2, 3]);
    // No temp files left behind.
    const dir = await fs.readdir(path.dirname(abs));
    expect(dir.filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  test('delete is idempotent (absent key is fine)', async () => {
    await expect(store.delete('t/x/m/y')).resolves.toBeUndefined();
  });
});

describe('SEC-MEDIA-04 path-traversal defense (blobs stay under the root)', () => {
  const traversals = [
    '../escape',
    't/../../etc/passwd',
    '/etc/passwd',
    't/../evil',
    't/./m/x', // current-dir segment
    '..\\windows',
    'C:/abs',
    't/\0/m/x',
  ];

  test.each(traversals)('put(%j) is rejected as UnsafeBlobKeyError', async (key) => {
    await expect(store.put(key, Uint8Array.from([1]))).rejects.toBeInstanceOf(UnsafeBlobKeyError);
  });

  test('after a traversal attempt, nothing was written outside the root', async () => {
    for (const key of traversals) {
      await store.put(key, Uint8Array.from([1])).catch(() => undefined);
    }
    // The root is empty (no dirs/files were created by the rejected puts).
    expect(await fs.readdir(root)).toEqual([]);
  });

  test('a well-formed server key writes strictly inside the root', async () => {
    const key = mediaStorageKey(
      '33333333-3333-7333-8333-333333333333',
      '44444444-4444-7444-8444-444444444444',
    );
    await store.put(key, Uint8Array.from([1, 2]));
    const abs = path.join(root, key);
    const real = await fs.realpath(abs);
    expect(real.startsWith(await fs.realpath(root))).toBe(true);
    expect(key).toMatch(/^t\/[0-9a-f-]{36}\/m\/[0-9a-f-]{36}$/);
  });
});
