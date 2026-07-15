// identity_audit writer (api/02-auth §1: "Every mutation appends a row to the append-only
// identity_audit table (actor, acted-on, ms-epoch timestamp, before/after JSONB)"; 10-db §7).
//
// Redaction is the load-bearing part: verifier salt/hash and password material NEVER enter
// before/after — "secret material is redacted to as_of only" (10-db §7 DDL). The redactor runs on
// every write, so even a caller that forgets to sanitize cannot leak a hash into the audit log.
import type { TenantDb } from '@bolusi/db-server';

import { uuidv7 } from '../uuidv7.js';

/** Keys whose VALUES are secret material and are dropped wholesale from before/after. */
const SECRET_KEYS = new Set([
  'password',
  'passwordVerifier',
  'currentPassword',
  'newPassword',
  'token',
  'tokenHash',
  'deviceToken',
  'controlSession',
  'salt',
  'saltB64',
  'hash',
  'hashB64',
]);

/**
 * Deep-redact secret material. A verifier record (carries salt + hash) collapses to its `asOf`
 * position only; any stray password/token/salt/hash key is dropped. Everything else survives.
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const looksLikeVerifier =
      ('saltB64' in obj && 'hashB64' in obj) || ('salt' in obj && 'hash' in obj);
    if (looksLikeVerifier) {
      return 'asOf' in obj
        ? { asOf: redactSecrets(obj['asOf']), redacted: true }
        : { redacted: true };
    }
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (SECRET_KEYS.has(key)) continue;
      out[key] = redactSecrets(val);
    }
    return out;
  }
  return value;
}

export interface AuditEntry {
  readonly actorUserId: string | null;
  /** e.g. 'user.created', 'user.deactivated', 'pin_verifier.replaced', 'device.revoked'. */
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  /** ms epoch. */
  readonly at: number;
}

/**
 * Append one identity_audit row inside the caller's `forTenant` transaction. `tenantId` is passed
 * explicitly so the INSERT satisfies the RLS WITH CHECK (tenant_id = app.tenant_id).
 */
export async function appendAudit(
  db: TenantDb,
  tenantId: string,
  entry: AuditEntry,
): Promise<void> {
  await db
    .insertInto('identityAudit')
    .values({
      id: uuidv7(entry.at),
      tenantId,
      actorUserId: entry.actorUserId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: entry.before === undefined ? null : (redactSecrets(entry.before) as never),
      after: entry.after === undefined ? null : (redactSecrets(entry.after) as never),
      at: BigInt(entry.at),
    })
    .execute();
}
