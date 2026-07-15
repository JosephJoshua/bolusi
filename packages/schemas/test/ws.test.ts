import { describe, expect, test } from 'vitest';

import { zSyncPokeMessage, zWsFrame, zWsMessage } from '../src/index.js';

describe('WS frame (api/00 §12.1) — client-ignore contract', () => {
  test('a sync.poke frame parses at frame level', () => {
    expect(zWsFrame.safeParse({ type: 'sync.poke', payload: {} }).success).toBe(true);
  });

  test('a frame with an unknown type parses at frame level (clients ignore unknown types)', () => {
    const result = zWsFrame.safeParse({ type: 'inventory.poke', payload: { storeCount: 2 } });
    expect(result.success).toBe(true);
  });

  test('a frame with a non-object payload fails', () => {
    expect(zWsFrame.safeParse({ type: 'sync.poke', payload: 'poke' }).success).toBe(false);
  });

  test('a frame missing payload fails', () => {
    expect(zWsFrame.safeParse({ type: 'sync.poke' }).success).toBe(false);
  });
});

describe('sync.poke message (api/00 §12.1) — frozen emission contract (SEC-RT-03 fixture)', () => {
  test('the canonical poke parses', () => {
    expect(zSyncPokeMessage.safeParse({ type: 'sync.poke', payload: {} }).success).toBe(true);
  });

  test('a non-empty payload fails', () => {
    const result = zSyncPokeMessage.safeParse({ type: 'sync.poke', payload: { since: 5 } });
    expect(result.success).toBe(false);
  });

  test('an extra top-level key fails', () => {
    const result = zSyncPokeMessage.safeParse({
      type: 'sync.poke',
      payload: {},
      ts: 1752485000777,
    });
    expect(result.success).toBe(false);
  });
});

describe('known-message registry (v0)', () => {
  test('zWsMessage parses sync.poke', () => {
    expect(zWsMessage.safeParse({ type: 'sync.poke', payload: {} }).success).toBe(true);
  });

  test('zWsMessage rejects a type outside the registry', () => {
    expect(zWsMessage.safeParse({ type: 'media.poke', payload: {} }).success).toBe(false);
  });
});
