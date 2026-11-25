/**
 * Perlu dicek's read: every request this person may answer comes with its servisan, however many
 * there are, and the servisan ids are read a page at a time.
 */
import { describe, expect, test } from 'vitest';

import { APPROVAL_PERMISSION } from '../src/approvals/constants.js';
import { APPROVALS_VIEW_MAX } from '../src/repair/flows.js';
import { readAttention } from '../src/repair/attention.js';
import type { RepairRuntime } from '../src/repair/runtime.js';

const COUNT = APPROVALS_VIEW_MAX * 2 + 5;

function runtime(): { readonly rt: RepairRuntime; readonly pages: number[] } {
  const pages: number[] = [];
  const requests = Array.from({ length: COUNT }, (_, n) => ({
    id: `req-${String(n)}`,
    targetId: `t-${String(n)}`,
    canDecide: true,
    requestedAt: n,
  }));
  const rt = {
    userId: 'u-owner',
    hasPermission: () => false,
    approvals: {
      hasPermission: (id: string) => id === APPROVAL_PERMISSION.use,
      query: async () => ({ rows: requests }),
    },
    query: async (name: string, input: { filter: { ids: readonly string[] }; limit: number }) => {
      expect(name).toBe('listTickets');
      expect(input.filter.ids.length).toBeLessThanOrEqual(input.limit);
      pages.push(input.filter.ids.length);
      return { rows: input.filter.ids.map((id) => ({ id, ticketNumber: id })) };
    },
  } as unknown as RepairRuntime;
  return { rt, pages };
}

describe('Perlu dicek', () => {
  test('reads the servisan of every request, a page of ids at a time', async () => {
    const { rt, pages } = runtime();
    const attention = await readAttention(rt, 0);
    expect(attention.requests).toHaveLength(COUNT);
    expect(attention.requests.every((row) => row.ticket !== null)).toBe(true);
    expect(pages).toEqual([APPROVALS_VIEW_MAX, APPROVALS_VIEW_MAX, 5]);
  });
});
