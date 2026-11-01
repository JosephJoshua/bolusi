// POST /v1/sync/pull query + devices sidecar (api/01-sync §4, §4.1, §4.3). A READ: it serves the
// tenant's op stream by serverSeq cursor within the device's pull scope, plus a full devices
// snapshot when the client's echoed directory version is stale. Runs inside one `forTenant`
// transaction (10-db §6) so RLS backstops the scope filter (SEC-SYNC-09; security-guide §4.1).
//
// db-server's generated types do not reach apps/server (task 39), so the query layer is unchecked
// against the schema — the real-Postgres tests are the correctness gate for column names, not tsc.
import type { ForTenant, TenantDb } from '@bolusi/db-server';
import {
  operationFromSignedCoreJcs,
  readPermissionsOf,
  typesReadWith,
  type ReadScopeRegistry,
} from '@bolusi/core';
import type { DeviceInfo, PullRequest, PullResponse, SignedOperation } from '@bolusi/schemas';

import { deviceReadSet, personExtraReadSet } from './read-set.js';

/** The token-authenticated device pulling (api/00 §3; store null = system/tenant-scoped device). */
export interface PullIdentity {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly storeId: string | null;
  /**
   * A person pull: the person a valid person session names on this device (the route checked it).
   * Served only what they may read beyond the device, for their session; never the device's own.
   */
  readonly personUserId?: string;
}

export interface PullDeps {
  readonly forTenant: ForTenant;
  readonly now: () => number;
  /** Which permission each op type is read with: a device is sent only what its read set covers. */
  readonly readScope: ReadScopeRegistry;
}

/**
 * Reconstruct the wire `SignedOperation` from the stored row. The signed core is served from the
 * VERBATIM JCS text (`signed_core_jcs`, 10-db §2.1) — never re-serialized from typed columns, whose
 * numeric round-trip can differ from the signed bytes and fail client-side verification (05 §3).
 * The client re-canonicalizes the parsed core (JCS is a fixpoint under JSON.parse∘canonicalize) to
 * recover the exact signed bytes, so parsing here is loss-free. `hash`/`signature` are the derived
 * §2.2 fields, stored in their own columns and re-attached.
 */
function reconstructWireOp(row: {
  signedCoreJcs: string;
  hash: string;
  signature: string;
}): SignedOperation {
  return operationFromSignedCoreJcs(row.signedCoreJcs, row);
}

/**
 * The per-tenant `devicesDirectoryVersion` (api/01-sync §4.1). No dedicated column exists server-
 * side (10-db has only the client-side `sync_state.devices_directory_version`) and this task adds
 * no migration, so it is DERIVED from the append-only device directory: `SNAPSHOT_SHAPE_OFFSET +
 * count(devices) + count(revoked devices)`. Devices are never hard-deleted (terminal `revoked`, no un-revoke —
 * 03-state-machines §5), so this is strictly monotonic and bumps by exactly one on every enrollment
 * (a new row) and every revocation (a newly-non-null `revoked_at`) — precisely "bumped on any device
 * enrollment/revocation". Tenant-wide (all stores), scoped by the `forTenant` RLS predicate; the
 * client treats it as opaque (api/00 §10).
 *
 * ── WHAT ACTUALLY MAKES THIS SAFE: the DDL CHECK, not the terminality argument ─────────────────
 *
 * This counts `revoked_at IS NOT NULL` while `deviceSnapshot` below reports `status = 'revoked'` —
 * TWO DIFFERENT COLUMNS. If they could ever disagree, a revocation would change the snapshot
 * WITHOUT bumping the version, the client's echoed version would still match, and it would keep
 * trusting a revoked device's signing key indefinitely. What forbids that divergence is the devices
 * DDL constraint `CHECK (status = 'active' OR revoked_at IS NOT NULL)`
 * (packages/db-server/migrations/0002_platform_directory.ts) — status `revoked` REQUIRES a non-null
 * `revoked_at`, so every state this counter reports as revoked is exactly the set the snapshot
 * reports as revoked. A future migration dropping that CHECK silently un-couples the two and
 * re-opens the hole; cited here so the connection is not left to be rediscovered.
 */
async function directoryVersion(db: TenantDb): Promise<number> {
  const row = await db
    .selectFrom('devices')
    .select((eb) => [eb.fn.countAll().as('total'), eb.fn.count('revokedAt').as('revoked')])
    .executeTakeFirstOrThrow();
  return SNAPSHOT_SHAPE_OFFSET + Number(row.total) + Number(row.revoked);
}

/**
 * Raised whenever what a snapshot holds changes, so every device's stored version stops matching
 * once and it fetches the new snapshot; the client re-verifies its quarantined ops against every
 * sidecar it receives (core sync/pull.ts), which releases the ones the old snapshot left unknown.
 * A version stored under the old offset is far below the new one, so the two never meet.
 * 1_000_000 (from 0): the snapshot became every device of the tenant, not only the puller's store's.
 */
const SNAPSHOT_SHAPE_OFFSET = 1_000_000;

/**
 * The devices sidecar snapshot (api/01-sync §4.1): EVERY device of the tenant, including the
 * tenant-scoped `kind: 'system'` device and any revoked devices (their historical signatures must
 * stay verifiable; the client keeps them for pull-side verification). Never contains other
 * tenants' devices (RLS).
 *
 * Not narrowed to the puller's store: the pull serves every `storeId IS NULL` op of the tenant,
 * and a member device at ANY store may author one (a locale change, a tenant inventory item, a
 * central money account). The client verifies each pulled op against this list, so a list without
 * the other stores' keys left those ops unverifiable and quarantined them on every other store.
 * Public keys are not secret, and the list carries no op content.
 */
async function deviceSnapshot(db: TenantDb): Promise<DeviceInfo[]> {
  const rows = await db
    .selectFrom('devices')
    .select(['id', 'storeId', 'kind', 'signingKeyPublic', 'status', 'revokedAt'])
    .orderBy('id')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    storeId: row.storeId,
    kind: row.kind === 'system' ? 'system' : 'member',
    signingKeyPublic: row.signingKeyPublic,
    status: row.status === 'revoked' ? 'revoked' : 'active',
    revokedAt: row.revokedAt === null ? null : Number(row.revokedAt),
  }));
}

export async function runPull(
  deps: PullDeps,
  identity: PullIdentity,
  request: PullRequest,
): Promise<PullResponse> {
  return deps.forTenant(identity.tenantId, async (db) => {
    const limit = request.limit; // schema default 500, hard max 500 (api/01-sync §4)
    // Permission-scoped sync: the types read with a permission outside the device's read set are
    // never sent. Filtering out (rather than listing what is allowed) keeps a type every device
    // reads, like sign-in records, flowing without a lookup.
    const device = await db
      .selectFrom('devices')
      .select(['personalUserId'])
      .where('id', '=', identity.deviceId)
      .executeTakeFirst();
    const readDevice = {
      storeId: identity.storeId,
      personalUserId: device?.personalUserId ?? null,
    };
    const person = identity.personUserId;
    const readSet =
      person === undefined
        ? await deviceReadSet(db, identity.tenantId, readDevice, deps.readScope)
        : await personExtraReadSet(db, identity.tenantId, readDevice, person, deps.readScope);
    const allowed = new Set(readSet);
    const hidden = typesReadWith(
      deps.readScope,
      readPermissionsOf(deps.readScope).filter((read) => !allowed.has(read)),
    );
    // A person pull is the same stream cut to the person's extra reads: only types read with one of
    // them, so nothing the device already holds (or every device reads) comes twice.
    const only = person === undefined ? undefined : typesReadWith(deps.readScope, readSet);
    // A catch-up pull asks for older ops of newly readable types only, up to where its normal pull
    // already is. What it asks for is still limited to what the device may read now.
    const backfill =
      request.backfill === undefined
        ? undefined
        : {
            types: typesReadWith(
              deps.readScope,
              request.backfill.reads.filter((read) => allowed.has(read)),
            ),
            through: request.backfill.through,
          };
    // The v0 pull scope (api/01-sync §4.3): `serverSeq > cursor AND (storeId = device.storeId OR
    // storeId IS NULL)`, ORDER BY serverSeq. Fetch one MORE than the page: the extra row answers "is
    // there a next page?" without a second COUNT, and pins nextCursor to the last SERVED op.
    const rows =
      (backfill !== undefined && backfill.types.length === 0) || only?.length === 0
        ? []
        : await db
            .selectFrom('operations')
            .select(['serverSeq', 'signedCoreJcs', 'hash', 'signature'])
            // `server_seq` is int8 → derived as `Int8 = ColumnType<string, ...>` (the pg driver
            // returns int8 as a string), so the comparison operand is typed `string`. pg serializes
            // 500 and '500' to the same wire value — this honours the derived type.
            .where('serverSeq', '>', String(request.cursor))
            .where((eb) => eb.or([eb('storeId', '=', identity.storeId), eb('storeId', 'is', null)]))
            .$if(hidden.length > 0, (qb) => qb.where('type', 'not in', hidden))
            .$if(only !== undefined, (qb) => qb.where('type', 'in', only ?? []))
            .$if(backfill !== undefined, (qb) =>
              qb
                .where('type', 'in', backfill?.types ?? [])
                .where('serverSeq', '<=', String(backfill?.through ?? 0)),
            )
            .orderBy('serverSeq')
            .limit(limit + 1)
            .execute();

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const ops = page.map(reconstructWireOp);
    // Opaque cursor = the last SERVED serverSeq; on an empty page (cursor at head) echo the request
    // cursor verbatim so a resume neither gaps nor overlaps (api/01-sync §4, api/00 §10).
    const last = page[page.length - 1];
    const nextCursor = last === undefined ? request.cursor : Number(last.serverSeq);

    const response: PullResponse = {
      ops,
      nextCursor,
      hasMore,
      serverTime: deps.now(),
      readSet: [...readSet],
    };

    // Devices sidecar (api/01-sync §4.1): only when the client's echoed version is stale. Equal ⇒
    // omit both fields (nothing changed since the client's last snapshot).
    // A person pull leaves it to the device's own pull: the device keeps one list of signers.
    const currentVersion = await directoryVersion(db);
    if (person === undefined && request.devicesDirectoryVersion !== currentVersion) {
      response.devices = await deviceSnapshot(db);
      response.devicesDirectoryVersion = currentVersion;
    }

    return response;
  });
}
