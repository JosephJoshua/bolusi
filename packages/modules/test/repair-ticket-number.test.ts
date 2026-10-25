// Offline ticket numbers: short, unambiguous, minted with no network.
import { describe, expect, test } from 'vitest';

import { deviceCode, formatTicketNumber } from '../src/repair/ticket-number.js';

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

  test('the counter is zero-padded to four digits and grows past them', () => {
    expect(formatTicketNumber(device, 42)).toMatch(/^[0-9A-Z]{3}-0042$/);
    expect(formatTicketNumber(device, 12345)).toMatch(/^[0-9A-Z]{3}-12345$/);
  });
});
