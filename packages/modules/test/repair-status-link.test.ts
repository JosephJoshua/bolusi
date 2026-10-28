// The customer's status link: a code made with the servisan at intake (offline) from a random nonce
// and where the servisan lives, read back from paper the forgiving way, and one per servisan.
import { afterEach, describe, expect, test } from 'vitest';

import { DomainError, refusalKeyOf } from '@bolusi/core';
import { STATUS_PAGE_GRACE_MS } from '@bolusi/schemas';
import { noblePort } from '@bolusi/test-support';

import { statusPageEndsAt } from '../src/repair/customer-status.js';
import {
  STATUS_CODE_PATTERN,
  displayStatusCode,
  normalizeStatusCode,
  statusCodeFor,
  statusLink,
  statusNonceFrom,
} from '../src/repair/status-link.js';
import { intake, openRepairHarness, type RepairHarness } from './support/repair-harness.js';

let h: RepairHarness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const DAY = 86_400_000;

describe('the code', () => {
  const owner = { tenantId: 't-1', storeId: 's-1', ticketId: 'k-1' };
  const nonce = statusNonceFrom(Uint8Array.from({ length: 16 }, (_, i) => i));
  const sha256 = (data: Uint8Array) => noblePort.sha256(data);

  test('is twelve Crockford base32 characters, the same for the same nonce and servisan', () => {
    expect(nonce).toBe('000102030405060708090a0b0c0d0e0f');
    expect(() => statusNonceFrom(new Uint8Array(15))).toThrow(RangeError);
    const code = statusCodeFor(owner, nonce, sha256);

    expect(code).toMatch(STATUS_CODE_PATTERN);
    expect(statusCodeFor({ ...owner }, nonce, sha256)).toBe(code);
  });

  test('changes with the nonce and with every part of where the servisan lives', () => {
    const code = statusCodeFor(owner, nonce, sha256);
    const others = [
      statusCodeFor(owner, nonce.replace(/f$/, 'e'), sha256),
      statusCodeFor({ ...owner, tenantId: 't-2' }, nonce, sha256),
      statusCodeFor({ ...owner, storeId: 's-2' }, nonce, sha256),
      statusCodeFor({ ...owner, ticketId: 'k-2' }, nonce, sha256),
    ];

    for (const other of others) expect(other).not.toBe(code);
  });

  test('typed from paper: any case, dashes and spaces, O for 0 and I or L for 1', () => {
    expect(normalizeStatusCode('k7m2-q9xa-4brs')).toBe('K7M2Q9XA4BRS');
    expect(normalizeStatusCode(' K7M2 Q9XA 4BRS ')).toBe('K7M2Q9XA4BRS');
    expect(normalizeStatusCode('O7M2-QIXA-L4RS')).toBe('07M2Q1XA14RS');
    // U is not in the alphabet, and a code is exactly twelve characters.
    for (const bad of ['K7M2Q9XA4BRU', 'K7M2Q9XA4BR', 'K7M2Q9XA4BRSS', '', 'K7M2/Q9XA/4BRS']) {
      expect(normalizeStatusCode(bad), bad).toBeNull();
    }
  });

  test('is shown in three groups of four, under the site that serves the page', () => {
    expect(displayStatusCode('K7M2Q9XA4BRS')).toBe('K7M2-Q9XA-4BRS');
    expect(statusLink('https://bolusi.id/', 'K7M2Q9XA4BRS')).toBe(
      'https://bolusi.id/c/K7M2Q9XA4BRS',
    );
  });
});

describe('the servisan', () => {
  test('gets its own code at intake from a nonce, and a second link is refused', async () => {
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
    expect(made.map((op) => op.entityId)).toEqual([first.ticketId, second.ticketId]);
    // The op carries the code and the nonce it comes from where the servisan lives.
    const payloads = made.map((op) => op.payload as { code: string; nonce: string });
    expect(payloads.map((p) => p.code)).toEqual([a, b]);
    payloads.forEach((p, i) => {
      const owner = { tenantId: h!.tenantId, storeId: h!.storeId, ticketId: made[i]!.entityId };
      expect(statusCodeFor(owner, p.nonce, (data) => noblePort.sha256(data))).toBe(p.code);
    });
    // The same op again, as a tampered phone might push it: the servisan already has its link.
    const err = await h.checkRule(made[0]!).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(refusalKeyOf(err)).toBe('repair.refusal.alreadyRecorded');
  });

  test('refuses a code its nonce does not give this servisan, as one copied off a slip', async () => {
    h = await openRepairHarness(4202);
    await h.run('openTicket', intake(h), h.cashierId);
    await h.run('openTicket', intake(h), h.cashierId);
    const made = (await h.ownOps()).filter((op) => op.type === 'repair.status_link_made');
    const [own, other] = made.map((op) => op.payload as { code: string; nonce: string });

    // The second servisan's link op, claiming the first one's code (with or without its nonce).
    for (const payload of [{ ...other!, code: own!.code }, own!]) {
      const forged = { ...made[1]!, payload };
      const err = await h.checkRule(forged).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DomainError);
      expect(refusalKeyOf(err)).toBe('repair.refusal.statusLinkMismatch');
    }
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
