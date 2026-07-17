import type { ClockPort } from '@bolusi/core';
import { describe, expect, test } from 'vitest';

import { FakeClock } from './clock.js';

describe('FakeClock (testing-guide §3.3)', () => {
  test('starts at 0 by default and reports it via now()', () => {
    const clock = new FakeClock();
    expect(clock.now()).toBe(0);
  });

  test('starts at the provided epoch ms', () => {
    const clock = new FakeClock(1_700_000_000_000);
    expect(clock.now()).toBe(1_700_000_000_000);
  });

  test('advance(ms) moves now() forward by exactly that many ms', () => {
    const clock = new FakeClock(1000);
    clock.advance(250);
    expect(clock.now()).toBe(1250);
    clock.advance(750);
    expect(clock.now()).toBe(2000);
  });

  test('set(ms) jumps now() to the given epoch, forward', () => {
    const clock = new FakeClock(1000);
    clock.set(5000);
    expect(clock.now()).toBe(5000);
  });

  test('set(ms) can roll the clock BACKWARDS (CHAOS-11 clock-rollback case)', () => {
    const clock = new FakeClock(5000);
    clock.set(1000);
    expect(clock.now()).toBe(1000);
  });

  test('advance(negative) throws — time only moves forward (CHAOS-04 skews via set, not negative advance)', () => {
    const clock = new FakeClock(1000);
    expect(() => clock.advance(-1)).toThrow(/forward|negative/i);
    expect(clock.now()).toBe(1000);
  });

  test('advance(non-integer) throws — epoch ms is integer (catches float drift, T-6)', () => {
    const clock = new FakeClock(1000);
    expect(() => clock.advance(1.5)).toThrow(/integer/i);
  });

  test('set(non-integer) throws — epoch ms is integer', () => {
    const clock = new FakeClock(1000);
    expect(() => clock.set(1.5)).toThrow(/integer/i);
  });

  test('constructor(non-integer) throws — epoch ms is integer', () => {
    expect(() => new FakeClock(1.5)).toThrow(/integer/i);
  });

  test('is assignable to core ClockPort (the injected runtime seam)', () => {
    const clock: ClockPort = new FakeClock();
    expect(typeof clock.now()).toBe('number');
  });
});
