/**
 * Money taken for a servisan changes how the servisan looks, so a payment recorded on another
 * device lights the servisan's row too. Cash moves are for no document and concern nothing else.
 */
import { expect, test } from 'vitest';

import type { ProjectionOperation } from '@bolusi/core';

import { moneyModule } from '../src/index.js';
import { MONEY_OP } from '../src/money/index.js';
import { REPAIR_DOCUMENT_KIND, REPAIR_TICKET_ENTITY } from '../src/repair/index.js';

const op = (type: string, payload: unknown): ProjectionOperation =>
  ({ type, payload }) as unknown as ProjectionOperation;

const concernsOf = (type: string, payload: unknown): unknown =>
  moneyModule.operations[type]?.concerns?.(op(type, payload));

test('a payment for a servisan concerns that servisan', () => {
  const document = { kind: REPAIR_DOCUMENT_KIND, id: 'ticket-1', label: 'BLS-1' };
  expect(concernsOf(MONEY_OP.paymentReceived, { document })).toEqual([
    { entityType: REPAIR_TICKET_ENTITY, entityId: 'ticket-1' },
  ]);
  expect(concernsOf(MONEY_OP.refundPaid, { document })).toEqual([
    { entityType: REPAIR_TICKET_ENTITY, entityId: 'ticket-1' },
  ]);
});

test('a cash move, or a document of a kind no module owns, concerns nothing else', () => {
  expect(concernsOf(MONEY_OP.cashMoved, { kind: 'deposit', amount: 1 })).toEqual([]);
  const stranger = { kind: 'unknown.kind', id: 'x', label: 'X' };
  expect(concernsOf(MONEY_OP.paymentReceived, { document: stranger })).toEqual([]);
});
