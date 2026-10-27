// The future-clock guard (sync/clock-guard.ts): the server refuses a timestamp too far ahead, and a
// device whose last sync found its clock that far ahead refuses to save anything.
import { describe, expect, it } from 'vitest';

import {
  assertDeviceClockTrusted,
  CLOCK_AHEAD_MARGIN_MS,
  DomainError,
  isAheadOfServer,
  isDeviceClockAhead,
} from '../../src/index.js';

const SERVER = 1_726_000_000_000;

describe('isAheadOfServer', () => {
  it('allows up to the margin and refuses one millisecond more', () => {
    expect(isAheadOfServer(SERVER + CLOCK_AHEAD_MARGIN_MS, SERVER)).toBe(false);
    expect(isAheadOfServer(SERVER + CLOCK_AHEAD_MARGIN_MS + 1, SERVER)).toBe(true);
  });

  it('never refuses a past timestamp: late sync is honest', () => {
    expect(isAheadOfServer(SERVER - 30 * 86_400_000, SERVER)).toBe(false);
  });
});

describe('isDeviceClockAhead', () => {
  const aheadBy = (ms: number) => ({
    lastServerTime: SERVER,
    lastServerTimeReceivedAt: SERVER + ms,
  });

  it('is false before the device ever synced', () => {
    expect(
      isDeviceClockAhead({ lastServerTime: null, lastServerTimeReceivedAt: null }, SERVER),
    ).toBe(false);
  });

  it('is true when the last pull found the clock beyond the margin, and it still runs on', () => {
    const reading = aheadBy(CLOCK_AHEAD_MARGIN_MS + 60_000);
    expect(isDeviceClockAhead(reading, reading.lastServerTimeReceivedAt + 5_000)).toBe(true);
  });

  it('is false within the margin', () => {
    const reading = aheadBy(CLOCK_AHEAD_MARGIN_MS);
    expect(isDeviceClockAhead(reading, reading.lastServerTimeReceivedAt)).toBe(false);
  });

  it('stands aside once the clock was moved back after that pull', () => {
    const reading = aheadBy(3 * 3_600_000);
    expect(isDeviceClockAhead(reading, SERVER + 60_000)).toBe(false);
  });
});

describe('assertDeviceClockTrusted', () => {
  it('throws CLOCK_AHEAD for a clock known to run ahead', () => {
    const reading = { lastServerTime: SERVER, lastServerTimeReceivedAt: SERVER + 3_600_000 };
    let thrown: unknown;
    try {
      assertDeviceClockTrusted(reading, SERVER + 3_600_000);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect((thrown as DomainError).code).toBe('CLOCK_AHEAD');
  });
});
