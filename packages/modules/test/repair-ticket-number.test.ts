// Offline ticket numbers: short, unambiguous, minted with no network.
import { describe, expect, test } from 'vitest';

import { deviceCode, formatTicketNumber, ticketCounter } from '../src/repair/ticket-number.js';

describe('ticket numbers', () => {
  const device = '01920000-0000-7000-8000-00000000d00a';

  test('device code is 3 unambiguous characters and stable', () => {
    const code = deviceCode(device);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{3}$/);
    expect(deviceCode(device)).toBe(code);
  });

  test('devices enrolled in the same millisecond still get different codes', () => {
    expect(deviceCode('01920000-0000-7000-8000-0000000000a1')).not.toBe(
      deviceCode('01920000-0000-7000-8000-0000000000b2'),
    );
  });

  test('format and parse round-trip', () => {
    const number = formatTicketNumber(device, 42);
    expect(number).toMatch(/^[0-9A-Z]{3}-0042$/);
    expect(ticketCounter(number)).toBe(42);
    expect(ticketCounter(formatTicketNumber(device, 12345))).toBe(12345);
    expect(ticketCounter('not a number')).toBeNull();
  });
});
