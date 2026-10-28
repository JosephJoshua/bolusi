// The servisan table's facets and sorts, as pure rules: one meaning for a queue and for search.
import { describe, expect, test } from 'vitest';

import type { TicketSummaryRow } from '../src/repair/queries.js';
import {
  NO_FACETS,
  UNASSIGNED,
  dayRangeBounds,
  facetsFor,
  matchesFacets,
  presetRange,
  sortRows,
  tableFilter,
  tableSort,
} from '../src/repair/table.js';

const NOW = new Date(2026, 9, 27, 15, 30).getTime();

function row(overrides: Partial<TicketSummaryRow>): TicketSummaryRow {
  return {
    id: 't1',
    ticketNumber: 'K7P-0001',
    customerId: 'c1',
    customerName: 'Benny',
    customerPhone: null,
    deviceBrand: 'Samsung',
    deviceModel: 'A14',
    deviceColor: '',
    deviceImei: null,
    complaint: '',
    outcome: 'received',
    outcomeNote: null,
    location: 'in_store',
    technicianId: null,
    technicianName: null,
    quoteTotal: 100_000,
    estimatedReadyAt: null,
    pendingProposals: 0,
    createdAt: NOW,
    updatedAt: NOW,
    cancelFee: null,
    cancelStandardFee: null,
    cancelledBy: null,
    cancelledByName: null,
    cancelledAt: null,
    ...overrides,
  } as TicketSummaryRow;
}

describe('servisan table rules', () => {
  test('quick date choices cover whole local days up to today', () => {
    expect(presetRange('today', NOW)).toEqual({ from: '2026-10-27', to: '2026-10-27' });
    expect(presetRange('last7', NOW)).toEqual({ from: '2026-10-21', to: '2026-10-27' });
    expect(presetRange('thisMonth', NOW)).toEqual({ from: '2026-10-01', to: '2026-10-27' });
    const { from, before } = dayRangeBounds({ from: '2026-10-27', to: '2026-10-27' });
    expect(from).toBe(new Date(2026, 9, 27).getTime());
    expect(before).toBe(new Date(2026, 9, 28).getTime());
  });

  test('a queue filter keeps the queue and adds only the facets it can use', () => {
    const facets = {
      ...NO_FACETS,
      statuses: ['waiting_for_parts', 'repaired'] as const,
      technicians: ['tech-1', UNASSIGNED],
      brands: ['Oppo'],
      priceWaiting: true,
    };
    expect(tableFilter('active', 'me', 0, facets)).toEqual({
      outcomes: ['waiting_for_parts'],
      location: 'in_store',
      technicianIds: ['tech-1'],
      unassigned: true,
      brands: ['Oppo'],
      hasPendingProposals: true,
    });
    // "Mine" already says whose tickets they are; the technician facet does not widen it.
    expect(tableFilter('mine', 'me', 0, facets)).toMatchObject({ technicianId: 'me' });
    expect(tableFilter('mine', 'me', 0, facets)).not.toHaveProperty('technicianIds');
  });

  test('search results narrow by the same facets', () => {
    const facets = { ...NO_FACETS, technicians: [UNASSIGNED], brands: ['samsung'] };
    expect(matchesFacets(row({}), facets)).toBe(true);
    expect(matchesFacets(row({ technicianId: 'tech-1' }), facets)).toBe(false);
    expect(matchesFacets(row({ deviceBrand: 'Oppo' }), facets)).toBe(false);
    // The status is the chip's: a phone back with its owner is "returned", not "repaired".
    const returned = { ...NO_FACETS, statuses: ['returned'] as const };
    expect(matchesFacets(row({ outcome: 'repaired', location: 'returned' }), returned)).toBe(true);
    expect(matchesFacets(row({ outcome: 'repaired' }), returned)).toBe(false);
    const today = { ...NO_FACETS, received: presetRange('today', NOW) };
    expect(matchesFacets(row({ createdAt: NOW - 86_400_000 }), today)).toBe(false);
  });

  test('column sorts map to the query and order search results by what the customer owes', () => {
    expect(tableSort('active', null)).toBe('createdAt.desc');
    expect(tableSort('cancelled', null)).toBe('cancelledAt.desc');
    expect(tableSort('active', { column: 'received', descending: false })).toBe('createdAt.asc');
    expect(tableSort('active', { column: 'total', descending: true })).toBe('total.desc');
    const rows = [
      row({ id: 'a', quoteTotal: 500_000, outcome: 'cancelled', cancelFee: 20_000 }),
      row({ id: 'b', quoteTotal: 100_000 }),
    ];
    expect(sortRows(rows, { column: 'total', descending: true }).map((r) => r.id)).toEqual([
      'b',
      'a',
    ]);
  });

  test('leaving search or a queue drops the choices the next queue cannot show', () => {
    const facets = {
      ...NO_FACETS,
      statuses: ['returned', 'in_repair'] as const,
      technicians: ['t'],
    };
    expect(facetsFor('active', facets)).toMatchObject({
      statuses: ['in_repair'],
      technicians: ['t'],
    });
    expect(facetsFor('mine', facets)).toMatchObject({ technicians: [] });
    // Names are encrypted on the device: a queue keeps its own order rather than sort ciphertext.
    expect(tableSort('active', { column: 'customer', descending: false })).toBe('createdAt.desc');
  });
});
