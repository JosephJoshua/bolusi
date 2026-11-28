// Client migration 35 — owners tick non-cash payments off against the bank statement.
//
// Mirrors server migration 0038: who confirmed a payment (a provider, recorded by the server) and
// the latest check of the rest.
import type { ClientMigration } from './types.js';

export const moneyPaymentChecksMigration: ClientMigration = {
  version: 35,
  name: 'money_payment_checks',
  statements: [
    `ALTER TABLE money_entries ADD COLUMN provider TEXT`,
    `ALTER TABLE money_entries ADD COLUMN checked_outcome TEXT`,
    `ALTER TABLE money_entries ADD COLUMN checked_by TEXT`,
    `ALTER TABLE money_entries ADD COLUMN checked_at INTEGER`,
  ],
};
