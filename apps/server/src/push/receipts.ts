// Token invalidation from tickets and delayed receipts (api/04-push §8).
//
// `DeviceNotRegistered` is the one signal that a token is dead: it arrives either IMMEDIATELY in a
// send ticket, or LATER in a delivery receipt polled ≥ 15 min after send. Both delete the row
// (the device re-registers on its next app start, §2). Every other per-message error is logged and
// the message dropped, but the row is KEPT — a `MessageTooBig` or a transient error is not proof the
// token is invalid. There is NO client-facing DELETE route; deletion is server-internal only.
import type { ForTenant } from '@bolusi/db-server';

import type { PushPort, PushTicket } from './port.js';

/** Delay before the receipt poll (api/04-push §7: "≥ 15 min after send"). */
export const RECEIPT_POLL_DELAY_MS = 15 * 60_000;

/** The Expo error string that means "this token is gone" (api/04-push §8; verified via Context7). */
export const DEVICE_NOT_REGISTERED = 'DeviceNotRegistered';

/**
 * A one-shot delayed-task seam (api/00 §12.1 pattern; T-6). Production wraps an `unref`'d timer;
 * tests inject a controllable fake so the ≥ 15 min receipt poll runs under fake timers with no wall
 * clock. `schedule` must never let the task's rejection escape — it is fire-and-forget.
 */
export interface ReceiptScheduler {
  schedule(delayMs: number, task: () => Promise<void>): void;
}

/** Default scheduler: a single `unref`'d timer, errors swallowed (best-effort — api/04-push §6). */
export const timerReceiptScheduler: ReceiptScheduler = {
  schedule(delayMs, task) {
    const timer = setTimeout(() => {
      void task().catch(() => undefined);
    }, delayMs);
    timer.unref?.();
  },
};

/** Delete a device's push-token row (§8). Idempotent; no-op if already gone (e.g. revoked). */
export async function deleteTokenForDevice(
  forTenant: ForTenant,
  tenantId: string,
  deviceId: string,
): Promise<void> {
  await forTenant(tenantId, (db) =>
    db.deleteFrom('pushTokens').where('deviceId', '=', deviceId).execute(),
  );
}

/** A receipt to poll later: the Expo receipt id and the device it belongs to. */
export interface PendingReceipt {
  readonly receiptId: string;
  readonly deviceId: string;
}

/**
 * Handle send tickets IMMEDIATELY (api/04-push §8): a `DeviceNotRegistered` ticket deletes the row
 * now; `ok` tickets yield receipts to poll later. Returns the receipts still worth polling.
 */
export async function invalidateFromTickets(
  forTenant: ForTenant,
  tenantId: string,
  tickets: readonly PushTicket[],
): Promise<PendingReceipt[]> {
  const pending: PendingReceipt[] = [];
  for (const ticket of tickets) {
    if (ticket.status === 'ok' && ticket.receiptId !== undefined) {
      pending.push({ receiptId: ticket.receiptId, deviceId: ticket.deviceId });
    } else if (ticket.status === 'error' && ticket.error === DEVICE_NOT_REGISTERED) {
      await deleteTokenForDevice(forTenant, tenantId, ticket.deviceId);
    }
    // Any other error: logged by the sender, row KEPT (§8).
  }
  return pending;
}

/**
 * Schedule the delayed receipt poll (§8). After `RECEIPT_POLL_DELAY_MS`, fetch receipts for the
 * pending ids and delete the row for every `DeviceNotRegistered`. No-op when nothing is pending.
 */
export function scheduleReceiptPoll(
  deps: { forTenant: ForTenant; pushPort: PushPort; receiptScheduler: ReceiptScheduler },
  tenantId: string,
  pending: readonly PendingReceipt[],
): void {
  if (pending.length === 0) return;
  deps.receiptScheduler.schedule(RECEIPT_POLL_DELAY_MS, async () => {
    const receipts = await deps.pushPort.getReceipts(pending.map((p) => p.receiptId));
    for (const p of pending) {
      const receipt = receipts.get(p.receiptId);
      if (receipt?.status === 'error' && receipt.error === DEVICE_NOT_REGISTERED) {
        await deleteTokenForDevice(deps.forTenant, tenantId, p.deviceId);
      }
    }
  });
}
