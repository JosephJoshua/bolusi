// device_anomalies recording (10-db §4; FR-829; security-guide §3.1 chain-break alarm).
//
// Written inside the push transaction for exactly the tamper-class rejections and clock-skew
// flags: BAD_SIGNATURE, CHAIN_BROKEN, SCOPE_VIOLATION, CLOCK_SKEW. NOT for CHAIN_GAP /
// CHAIN_HALTED / DEVICE_REVOKED / SCHEMA_INVALID / UNKNOWN_TYPE / duplicate (routine or
// version-skew, not tamper indicators). `detail` carries the op id + context and NEVER the
// rejected op body — the op itself is never stored (05 §5).
import type { TenantDb } from '@bolusi/db-server';

/** The four `device_anomalies.kind` values (10-db §4 CHECK). */
export const ANOMALY_KINDS = [
  'BAD_SIGNATURE',
  'CHAIN_BROKEN',
  'SCOPE_VIOLATION',
  'CLOCK_SKEW',
] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];

/** Anomaly context — op id + short reason, deliberately NOT the op payload/body (10-db §4). */
export interface AnomalyDetail {
  readonly opId: string;
  readonly seq: number;
  readonly reason: string;
}

export interface RecordAnomalyInput {
  readonly id: string;
  readonly tenantId: string;
  readonly deviceId: string;
  readonly kind: AnomalyKind;
  readonly at: number;
  readonly detail: AnomalyDetail;
}

export async function recordAnomaly(db: TenantDb, input: RecordAnomalyInput): Promise<void> {
  await db
    .insertInto('deviceAnomalies')
    .values({
      id: input.id,
      tenantId: input.tenantId,
      deviceId: input.deviceId,
      kind: input.kind,
      at: BigInt(input.at),
      detail: JSON.stringify(input.detail),
    })
    .execute();
}
