// The customer's status link: a random code made with the servisan at intake (offline), read back
// from paper the forgiving way, and one per servisan.
import { afterEach, describe, expect, test } from 'vitest';

import { DomainError, refusalKeyOf } from '@bolusi/core';
import { STATUS_PAGE_GRACE_MS } from '@bolusi/schemas';

import { statusPageEndsAt } from '../src/repair/customer-status.js';
import {
  STATUS_CODE_PATTERN,
  displayStatusCode,
  normalizeStatusCode,
  statusCodeFrom,
  statusLink,
} from '../src/repair/status-link.js';
import { intake, openRepairHarness, type RepairHarness } from './support/repair-harness.js';

let h: RepairHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const DAY = 86_400_000;

describe('the code', () => {
  test('is ten Crockford base32 characters drawn from the bytes', () => {
    const zeros = statusCodeFrom(new Uint8Array(7));
    const ones = statusCodeFrom(new Uint8Array(7).fill(0xff));
    const mixed = statusCodeFrom(Uint8Array.from([1, 2, 3, 4, 5, 6, 7]));

    expect(zeros).toBe('0000000000');
    expect(ones).toBe('ZZZZZZZZZZ');
    for (const code of [zeros, ones, mixed]) expect(code).toMatch(STATUS_CODE_PATTERN);
    expect(mixed).toBe(statusCodeFrom(Uint8Array.from([1, 2, 3, 4, 5, 6, 7])));
    expect(mixed).not.toBe(statusCodeFrom(Uint8Array.from([1, 2, 3, 4, 5, 6, 8])));
    expect(() => statusCodeFrom(new Uint8Array(6))).toThrow(RangeError);
  });

  test('typed from paper: any case, dashes and spaces, O for 0 and I or L for 1', () => {
    expect(normalizeStatusCode('k7m2q-9xa4b')).toBe('K7M2Q9XA4B');
    expect(normalizeStatusCode(' K7M2Q 9XA4B ')).toBe('K7M2Q9XA4B');
    expect(normalizeStatusCode('O7M2Q-IXAL4')).toBe('07M2Q1XA14');
    // U is not in the alphabet, and a code is exactly ten characters.
    for (const bad of ['K7M2Q9XA4U', 'K7M2Q9XA4', 'K7M2Q9XA4BB', '', 'K7M2Q/9XA4B']) {
      expect(normalizeStatusCode(bad), bad).toBeNull();
    }
  });

  test('is shown in two groups of five, under the site that serves the page', () => {
    expect(displayStatusCode('K7M2Q9XA4B')).toBe('K7M2Q-9XA4B');
    expect(statusLink('https://bolusi.id/', 'K7M2Q9XA4B')).toBe('https://bolusi.id/c/K7M2Q9XA4B');
  });
});

describe('the servisan', () => {
  test('gets its own code at intake, and a second code is refused', async () => {
    h = await openRepairHarness(4201);
    const first = (await h.run('openTicket', intake(h), h.cashierId)) as { ticketId: string };
    const second = (await h.run('openTicket', intake(h), h.cashierId)) as { ticketId: string };

    const codeOf = async (ticketId: string) =>
      ((await h!.query('getTicket', { ticketId }, h!.cashierId)).rows[0] as { statusCode: string })
        .statusCode;
    const [a, b] = [await codeOf(first.ticketId), await codeOf(second.ticketId)];
    expect(a).toMatch(STATUS_CODE_PATTERN);
    expect(b).toMatch(STATUS_CODE_PATTERN);
    expect(a).not.toBe(b);

    const made = (await h.ownOps()).filter((op) => op.type === 'repair.status_link_made');
    expect(made.map((op) => [op.entityId, op.payload])).toEqual([
      [first.ticketId, { code: a }],
      [second.ticketId, { code: b }],
    ]);
    // The same op again, as a tampered phone might push it: the servisan already has its link.
    const err = await h.checkRule(made[0]!).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(refusalKeyOf(err)).toBe('repair.refusal.alreadyRecorded');
  });
});

describe('the page', () => {
  test('stays up while the phone is in the store, then until 30 days after the warranty', () => {
    const screen = { warrantyDays: 30 };
    const none = { warrantyDays: 0 };
    const pickup = Date.UTC(2026, 9, 28);

    expect(statusPageEndsAt([screen], null)).toBeNull();
    expect(statusPageEndsAt([screen, none], pickup)).toBe(pickup + 30 * DAY + STATUS_PAGE_GRACE_MS);
    expect(statusPageEndsAt([none], pickup)).toBe(pickup + STATUS_PAGE_GRACE_MS);
    expect(statusPageEndsAt([], pickup)).toBe(pickup + STATUS_PAGE_GRACE_MS);
  });
});
