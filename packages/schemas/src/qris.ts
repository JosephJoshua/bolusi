// Integrated QRIS through Xendit (product-scope.md, "Repair payments"). A QRIS payment account can
// be connected to the Xendit account that settles it; the counter then shows the customer a QR for
// the exact amount, and when Xendit confirms the payment the server records it as an ordinary money
// record that every device pulls. Online only: offline, the counter takes QRIS by hand as before.
// Defined once here for the server's validators and the devices' client.
import { z } from 'zod';

import { zUuid, zUuidV7 } from './primitives.js';

/** Xendit's test mode (a key starting `xnd_development_`) or real money. */
export const QRIS_ENVIRONMENTS = ['test', 'live'] as const;
export const zQrisEnvironment = z.enum(QRIS_ENVIRONMENTS);
export type QrisEnvironment = z.infer<typeof zQrisEnvironment>;

/** The smallest QRIS payment Xendit takes, in rupiah. */
export const QRIS_MIN_AMOUNT = 1_500;
/** How long a QR stays payable: long enough for a customer at the counter, short enough to forget. */
export const QRIS_TTL_MS = 15 * 60 * 1000;

/** `PUT /v1/money/qris/accounts/:accountId`: connect a QRIS account with its Xendit secret key. */
export const zQrisConnectBody = z
  .object({ secretKey: z.string().trim().min(20).max(200) })
  .strict();
export type QrisConnectBody = z.infer<typeof zQrisConnectBody>;

export const zQrisConnection = z.object({
  accountId: zUuid,
  environment: zQrisEnvironment,
  connectedAt: z.number().int(),
});
export type QrisConnection = z.infer<typeof zQrisConnection>;

/** `GET /v1/money/qris/accounts`: the connected accounts this device's store can use or manage. */
export const zQrisConnectionsResponse = z.object({ connections: z.array(zQrisConnection) });
export type QrisConnectionsResponse = z.infer<typeof zQrisConnectionsResponse>;

/**
 * `POST /v1/money/qris/charges`: a QR for one payment. `id` is minted by the device, so a retry
 * after a lost answer gets the same QR back; it becomes the payment's money record id.
 */
export const zQrisChargeBody = z
  .object({
    /** A UUIDv7, like every record id a device mints. */
    id: zUuidV7,
    accountId: zUuid,
    document: z
      .object({
        kind: z.string().min(1).max(40),
        id: zUuid,
        label: z.string().trim().min(1).max(80),
      })
      .strict(),
    amount: z.number().int().min(QRIS_MIN_AMOUNT).max(1_000_000_000_000),
  })
  .strict();
export type QrisChargeBody = z.infer<typeof zQrisChargeBody>;

export const QRIS_CHARGE_STATUSES = ['waiting', 'paid', 'expired'] as const;
export type QrisChargeStatus = (typeof QRIS_CHARGE_STATUSES)[number];

export const zQrisCharge = z.object({
  id: zUuid,
  status: z.enum(QRIS_CHARGE_STATUSES),
  amount: z.number().int(),
  /** What the QR encodes (EMVCo); a device draws it. A placeholder in test mode. */
  qrString: z.string(),
  environment: zQrisEnvironment,
  expiresAt: z.number().int(),
  paidAt: z.number().int().nullable(),
});
export type QrisCharge = z.infer<typeof zQrisCharge>;
