// QRIS through Xendit, as a device sees it (server: apps/server/src/qris). A QRIS method can be
// connected to the store's Xendit account; the counter then shows the customer a QR for the exact
// amount, and once Xendit confirms the payment the server records it as an ordinary money record
// that reaches this device by sync. Online only: offline, or with Xendit down, the counter takes
// QRIS by hand as before. Platform-free: the phone and the PC bind the same port over HTTP.
import type { QrisCharge, QrisChargeBody, QrisConnection } from '@bolusi/schemas';

import { MONEY_PERMISSION } from './constants.js';
import type { MoneyKey } from './i18n.js';

/** Why a QRIS call did not go through, as the counter can act on it. */
export type QrisFailure =
  | 'offline'
  | 'denied'
  /** The method or the servisan has not reached the server yet. */
  | 'notFound'
  | 'notConnected'
  /** Xendit refused the key: wrong, revoked, or without QRIS. */
  | 'keyRefused'
  | 'amountRefused'
  /** QRIS through Xendit is not set up on the server, or Xendit did not answer. */
  | 'unavailable'
  /** The payment itself would be refused (its document, the method switched off). */
  | 'refused'
  | 'unexpected';

export class QrisError extends Error {
  constructor(readonly reason: QrisFailure) {
    super(`QRIS call failed: ${reason}`);
    this.name = 'QrisError';
  }
}

export const QRIS_FAILURES: readonly QrisFailure[] = [
  'offline',
  'denied',
  'notFound',
  'notConnected',
  'keyRefused',
  'amountRefused',
  'unavailable',
  'refused',
  'unexpected',
];

export function qrisFailure(error: unknown): QrisFailure {
  return error instanceof QrisError ? error.reason : 'unexpected';
}

/** What the counter reads for a failure. */
export const QRIS_FAILURE_KEY: Record<QrisFailure, MoneyKey> = {
  offline: 'money.qris.failure.offline',
  denied: 'money.qris.failure.denied',
  notFound: 'money.qris.failure.notFound',
  notConnected: 'money.qris.failure.notConnected',
  keyRefused: 'money.qris.failure.keyRefused',
  amountRefused: 'money.qris.failure.amountRefused',
  unavailable: 'money.qris.failure.unavailable',
  refused: 'money.qris.failure.refused',
  unexpected: 'money.qris.failure.unexpected',
};

/** The server calls, as the person signed in on this device. Each rejects with a {@link QrisError}. */
export interface QrisPort {
  /** The connected methods this store can use or manage. */
  connections(): Promise<readonly QrisConnection[]>;
  connect(accountId: string, secretKey: string): Promise<QrisConnection>;
  disconnect(accountId: string): Promise<void>;
  /** A QR for one payment; the same body again returns the same QR. */
  createCharge(body: QrisChargeBody): Promise<QrisCharge>;
  /** Paid yet? */
  charge(id: string): Promise<QrisCharge>;
  /** Test mode only, for someone who manages the method: Xendit pays the QR. */
  simulate(id: string): Promise<QrisCharge>;
}

/**
 * Whether to offer test mode's "pay it": the server lets someone who manages the method do it
 * (a store's own method or a central one), and checks which.
 */
export function canSimulateQris(hasPermission: (permission: string) => boolean): boolean {
  return (
    hasPermission(MONEY_PERMISSION.manageAccounts) ||
    hasPermission(MONEY_PERMISSION.manageCentralAccounts)
  );
}
