// Numbers a device mints offline (a servisan's `K7Q-0042`, a supplier order's `PO-K7Q-0001`): the
// rule both sides run so a device uses only its own code and never the same number twice. Two
// devices may share a 3-letter code (device-code.ts), so "used" is bound to the device through the
// op log, which both sides keep with the same columns: that rare collision never refuses an honest
// record.
import { carriedRegistrations } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';
import { sql, type Kysely } from 'kysely';

import { deviceCode } from './device-code.js';

export interface DeviceNumberCheck {
  readonly number: string;
  /** What comes before the device code ('' for a servisan, 'PO-' for an order). */
  readonly prefix: string;
  /** The snake_case table and column the number is kept in, scoped by `store_id`. */
  readonly table: string;
  readonly column: string;
  readonly notThisDevice: () => Error;
  readonly used: () => Error;
}

/**
 * Refuse a number this device did not mint (nor an earlier registration it carried changes over
 * from), or one it already used.
 */
export async function requireDeviceNumber<DB>(
  db: Kysely<DB>,
  op: SignedOperation,
  check: DeviceNumberCheck,
): Promise<void> {
  const devices = await carriedRegistrations(db, op.deviceId);
  const counter = check.number.slice(check.prefix.length);
  const minted = devices.some((device) => counter.startsWith(`${deviceCode(device)}-`));
  if (!check.number.startsWith(check.prefix) || !minted || !/^[0-9A-Z]{3}-\d{4,}$/.test(counter)) {
    throw check.notThisDevice();
  }
  const { rows } = await sql<{ one: number }>`
    SELECT 1 AS one FROM ${sql.table(check.table)} t
    JOIN operations o ON o.entity_id = t.id AND o.type = ${op.type}
    WHERE t.store_id = ${op.storeId} AND ${sql.ref(`t.${check.column}`)} = ${check.number}
      AND o.device_id IN (${sql.join(devices)})
    LIMIT 1
  `.execute(db);
  if (rows.length > 0) throw check.used();
}
