// What a device folds, and what it keeps only as links in its chain (least-privilege sync, owner
// decisions 2026-10-31 and 2026-11-01). A device holds on disk only what its read set covers. Its
// own changes of other types (an owner ordering parts on the store's counter PC) stay in its log,
// because its signed chain runs through them, but they fold only in that person's in-memory store,
// and once the server has them their text is cleared: the hash and chain links stay, the content
// goes. A change still waiting to be sent keeps its text, the one exception, since it must be sent.
//
// This file is the one place a device's own op-log rows lose and regain their text (lint
// allowlist `bolusi/oplog-held-text-allowlist`): never their id, hash, chain links or signature,
// and never another device's rows.
import type { SignedOperation } from '@bolusi/schemas';
import { sql, type Kysely } from 'kysely';

import { encryptColumnValue, SIGNED_CORE_SEAL } from '../crypto/column-cipher.js';
import type { CryptoPort } from '../crypto/port.js';
import { signedCoreJcsOf } from '../crypto/signed-core.js';
import type { ReadScopeRegistry } from './read-scope.js';

/** The device's read set as the fold asks it: per op type, may this device hold it? */
export class DeviceReads {
  private reads: ReadonlySet<string> | null;

  constructor(
    private readonly registry: ReadScopeRegistry,
    readSet: readonly string[] | null,
  ) {
    this.reads = readSet === null ? null : new Set(readSet);
  }

  /** Follow the read set the server last sent (null: a device that never had one holds all). */
  set(readSet: readonly string[] | null): void {
    this.reads = readSet === null ? null : new Set(readSet);
  }

  /** Whether the device folds `type`. Types every device reads, and unknown ones, always do. */
  readonly folds = (type: string): boolean => {
    if (this.reads === null) return true;
    const read = this.registry.readPermissionFor(type);
    return typeof read !== 'string' || this.reads.has(read);
  };

  /**
   * Whether the device holds what `permission` reads: true for a permission no op type is read
   * with (it guards no synced data), and for every read in the device's set.
   */
  holdsRead(permission: string): boolean {
    if (this.reads === null || this.reads.has(permission)) return true;
    return !this.registry
      .types()
      .some((type) => this.registry.readPermissionFor(type) === permission);
  }

  /** The read permissions some op type is read with that the device does not hold. */
  heldReads(): readonly string[] {
    const held = new Set<string>();
    for (const type of this.heldTypes()) {
      const read = this.registry.readPermissionFor(type);
      if (typeof read === 'string') held.add(read);
    }
    return [...held].sort();
  }

  /** The registered types the device keeps only as chain links. */
  heldTypes(): readonly string[] {
    return this.registry.types().filter((type) => !this.folds(type));
  }
}

/**
 * Clear the text of this device's own changes of held types once the server has them. Run after
 * every push and whenever the read set shrinks.
 */
export async function clearHeldText<DB>(db: Kysely<DB>, types: readonly string[]): Promise<void> {
  if (types.length === 0) return;
  await sql`
    UPDATE operations SET signed_core_jcs = ''
    WHERE arrival_seq IS NULL AND sync_status = 'synced' AND signed_core_jcs <> ''
      AND type IN (${sql.join(types)})
  `.execute(db);
}

/** Whether the log holds `id` only as a chain link, its text cleared. */
export async function isClearedOp<DB>(db: Kysely<DB>, id: string): Promise<boolean> {
  const result = await sql<{ one: number }>`
    SELECT 1 AS one FROM operations WHERE id = ${id} AND signed_core_jcs = '' LIMIT 1
  `.execute(db);
  return result.rows.length > 0;
}

/**
 * Put back the text of a cleared own change the device may read again, as the server sent it.
 * Only a row whose hash matches takes it, so the chain link and the text agree. Returns whether
 * it is restored.
 */
export async function restoreClearedOp<DB>(
  db: Kysely<DB>,
  op: SignedOperation,
  crypto: CryptoPort,
): Promise<boolean> {
  await sql`
    UPDATE operations
    SET signed_core_jcs = ${encryptColumnValue(db, signedCoreJcsOf(op, crypto), SIGNED_CORE_SEAL)}
    WHERE id = ${op.id} AND hash = ${op.hash} AND signed_core_jcs = ''
  `.execute(db);
  // Read back rather than trust a driver's affected-row count (not every driver reports one).
  return !(await isClearedOp(db, op.id));
}
