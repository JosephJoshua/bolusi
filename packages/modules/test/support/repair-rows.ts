// Ticket rows as the repair queries return them, for tests of what screens and slips make of them.
import type { QuoteLineRow, TicketDetailRow } from '../../src/repair/queries.js';

export const AT = Date.UTC(2026, 9, 26, 5, 30);

export function line(overrides: Partial<QuoteLineRow>): QuoteLineRow {
  return {
    id: 'line',
    kind: 'part',
    description: 'Ganti LCD',
    amount: 850_000,
    status: 'intake',
    reason: null,
    customerAgreed: null,
    createdBy: 'u1',
    createdAt: AT,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    ...overrides,
  };
}

export function sampleTicket(overrides: Partial<TicketDetailRow> = {}): TicketDetailRow {
  return {
    id: 't1',
    ticketNumber: 'K7Q-0042',
    customerId: 'c1',
    customerName: 'Yohanes Wanimbo',
    customerPhone: '081234567890',
    deviceBrand: 'Samsung',
    deviceModel: 'Galaxy A15',
    deviceColor: 'Hitam',
    deviceImei: '356789012345678',
    complaint: 'Layar retak, touchscreen tidak respon di bagian bawah.',
    outcome: 'received',
    outcomeNote: null,
    location: 'in_store',
    technicianId: null,
    technicianName: null,
    quoteTotal: 950_000,
    estimatedReadyAt: AT + 2 * 86_400_000,
    pendingProposals: 0,
    createdAt: AT,
    updatedAt: AT,
    cancelFee: null,
    cancelStandardFee: null,
    cancelledBy: null,
    cancelledByName: null,
    cancelledAt: null,
    downPayment: null,
    readyAt: null,
    repairTypes: [],
    claimOfTicketId: null,
    claimOf: null,
    claims: [],
    statusCode: 'K7M2Q9XA4BRS',
    slipPrints: { intake: 0, handover: 0 },
    devicePasscode: 'pin:975319',
    intakeNotes: 'Ada goresan di bodi belakang.',
    checklist: [
      { item: 'screen', label: null, state: 'issue', note: 'retak' },
      { item: 'camera', label: null, state: 'ok', note: '' },
      { item: 'speaker', label: 'Speaker bawah', state: 'not_checked', note: '' },
    ],
    peripherals: [{ item: 'charger', label: null }],
    intakePhotos: [],
    createdBy: 'u1',
    createdByName: 'Maria Kasir',
    returnedBy: null,
    returnedByName: null,
    returnedAt: null,
    workStarted: false,
    quoteLines: [
      line({ id: 'l1' }),
      line({ id: 'l2', kind: 'labour', description: 'Jasa pasang', amount: 100_000 }),
      line({ id: 'l3', description: 'Ganti baterai', amount: 300_000, status: 'proposed' }),
    ],
    photos: [],
    events: [],
    ...overrides,
  };
}
