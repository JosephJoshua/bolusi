// The in-memory fixed-window store stays bounded: its keys carry client addresses and the login
// identifiers callers send, so a window kept for every key ever seen would grow without limit.
import { describe, expect, test } from 'vitest';

import { InMemoryWindowLimitStore } from './rate-limits.js';

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

describe('InMemoryWindowLimitStore eviction', () => {
  test('windows that have ended are dropped at the next sweep', () => {
    const store = new InMemoryWindowLimitStore();
    for (let i = 0; i < 1000; i += 1) store.hit(`login-fail:id-${i}`, 5, 15 * 60_000, T0);
    expect(store.size).toBe(1000);

    store.hit('login-ip:203.0.113.7', 30, HOUR, T0 + 15 * 60_000);
    expect(store.size).toBe(1);
  });

  test('a window still open survives the sweep and keeps its count', () => {
    const store = new InMemoryWindowLimitStore();
    for (let i = 0; i < 5; i += 1)
      expect(store.hit('login-fail:x', 5, HOUR, T0).allowed).toBe(true);
    store.hit('other', 5, 60_000, T0 + 120_000); // sweeps; x's hour-long window is still open
    expect(store.size).toBe(2);
    expect(store.hit('login-fail:x', 5, HOUR, T0 + 120_000).allowed).toBe(false);
  });

  test('the number of live windows never exceeds the ceiling; the least recently used goes first', () => {
    const store = new InMemoryWindowLimitStore({ maxWindows: 3 });
    store.hit('k1', 1, HOUR, T0);
    store.hit('k2', 1, HOUR, T0);
    store.hit('k3', 1, HOUR, T0);
    store.hit('k1', 1, HOUR, T0); // k1 is now the most recently used (count 2, over its limit of 1)
    store.hit('k4', 1, HOUR, T0);
    expect(store.size).toBe(3);
    // k2 was evicted, not the recently touched k1, which is still over its limit.
    expect(store.hit('k1', 1, HOUR, T0).allowed).toBe(false);
  });
});
