// POST /v1/sync/pull query + devices sidecar (api/01-sync §4, §4.1, §4.3). A READ: it serves the
// tenant's op stream by serverSeq cursor within the device's pull scope, plus a full devices
// snapshot when the client's echoed directory version is stale. Runs inside one `forTenant`
// transaction (10-db §6) so RLS backstops the scope filter (SEC-SYNC-09; security-guide §4.1).
//
// db-server's generated types do not reach apps/server (task 39), so the query layer is unchecked
// against the schema — the real-Postgres tests are the correctness gate for column names, not tsc.
import type { ForTenant, TenantDb } from '@bolusi/db-server';
import type { DeviceInfo, PullRequest, PullResponse, SignedOperation } from '@bolusi/schemas';

/** The token-authenticated device pulling (api/00 §3; store null = system/tenant-scoped device). */
export interface PullIdentity {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly storeId: string | null;
}

export interface PullDeps {
  readonly forTenant: ForTenant;
  readonly now: () => number;
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
  const core = JSON.parse(row.signedCoreJcs) as Record<string, unknown>;
  return { ...core, hash: row.hash, signature: row.signature } as SignedOperation;
}

/**
 * The per-tenant `devicesDirectoryVersion` (api/01-sync §4.1). No dedicated column exists server-
 * side (10-db has only the client-side `sync_state.devices_directory_version`) and this task adds
 * no migration, so it is DERIVED from the append-only device directory: `count(devices) +
 * count(revoked devices)`. Devices are never hard-deleted (terminal `revoked`, no un-revoke —
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
  return Number(row.total) + Number(row.revoked);
}

/**
 * The devices sidecar snapshot (api/01-sync §4.1): the FULL directory of the device's pull scope
 * — `storeId = device.storeId OR storeId IS NULL` — including the tenant-scoped `kind: 'system'`
 * device and any revoked devices (their historical signatures must stay verifiable; the client
 * keeps them for pull-side verification). Never contains other tenants' (RLS) or other stores'
 * devices (the scope predicate). For a store-less device the store leg matches nothing, leaving
 * `storeId IS NULL` — the system devices only.
 */
async function deviceSnapshot(db: TenantDb, storeId: string | null): Promise<DeviceInfo[]> {
  const rows = await db
    .selectFrom('devices')
    .select(['id', 'storeId', 'kind', 'signingKeyPublic', 'status', 'revokedAt'])
    .where((eb) => eb.or([eb('storeId', '=', storeId), eb('storeId', 'is', null)]))
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
    // The v0 pull scope (api/01-sync §4.3): `serverSeq > cursor AND (storeId = device.storeId OR
    // storeId IS NULL)`, ORDER BY serverSeq. Fetch one MORE than the page: the extra row answers "is
    // there a next page?" without a second COUNT, and pins nextCursor to the last SERVED op.
    const rows = await db
      .selectFrom('operations')
      .select(['serverSeq', 'signedCoreJcs', 'hash', 'signature'])
      .where('serverSeq', '>', request.cursor)
      .where((eb) => eb.or([eb('storeId', '=', identity.storeId), eb('storeId', 'is', null)]))
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
    };

    // Devices sidecar (api/01-sync §4.1): only when the client's echoed version is stale. Equal ⇒
    // omit both fields (nothing changed since the client's last snapshot).
    const currentVersion = await directoryVersion(db);
    if (request.devicesDirectoryVersion !== currentVersion) {
      response.devices = await deviceSnapshot(db, identity.storeId);
      response.devicesDirectoryVersion = currentVersion;
    }

    return response;
  });
}
