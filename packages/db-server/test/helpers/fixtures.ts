// Seeded fixtures. testing-guide T-3: every case builds its OWN values — no shared
// `TEST_TENANT_ID` constants, because shared constants make tests pass by coincidence and fail
// in bulk. Every call to `uuid()` returns a value no other case has seen.
//
// The determinism kit (mulberry32/FakeClock/IdSource, testing-guide §3.3) lives in
// @bolusi/test-support, which is still a placeholder shell at this task's commit — so this is a
// LOCAL, deliberately tiny stand-in for id generation only. It is deterministic (a counter, not
// an RNG — T-6 forbids real RNG in tests) and should be replaced by the kit when it lands.
import type { Kysely } from 'kysely';

import type { DB } from '../../src/generated/db.js';

let counter = 0;

/** A unique lowercase canonical UUID (v7 layout). Deterministic per process; unique per call. */
export function uuid(): string {
  counter += 1;
  const tail = counter.toString(16).padStart(12, '0');
  return `0198f000-0000-7000-8000-${tail}`;
}

/** A distinct ms-epoch stamp per call (10-db-schema §2: timestamps are ms-epoch integers). */
export function timestampMs(): number {
  counter += 1;
  return 1_752_000_000_000 + counter;
}

export interface TenantFixture {
  readonly tenantId: string;
  readonly storeId: string;
  readonly deviceId: string;
  readonly userId: string;
}

/**
 * Seeds one tenant + store + device + user through the OWNER handle.
 *
 * Seeding bypasses RLS on purpose: a fixture's job is to put rows on the other side of the
 * boundary so a probe can fail to reach them. Probes must use `appForTenant` instead.
 */
export async function seedTenant(db: Kysely<DB>): Promise<TenantFixture> {
  const tenantId = uuid();
  const storeId = uuid();
  const deviceId = uuid();
  const userId = uuid();

  await db
    .insertInto('tenants')
    .values({ id: tenantId, name: `tenant-${tenantId}`, createdAt: BigInt(timestampMs()) })
    .execute();

  await db
    .insertInto('stores')
    .values({
      id: storeId,
      tenantId,
      name: `store-${storeId}`,
      createdAt: BigInt(timestampMs()),
    })
    .execute();

  await db
    .insertInto('devices')
    .values({
      id: deviceId,
      tenantId,
      storeId,
      kind: 'member',
      signingKeyPublic: `pubkey-${deviceId}`,
      enrolledAt: BigInt(timestampMs()),
    })
    .execute();

  await db
    .insertInto('users')
    .values({
      id: userId,
      tenantId,
      name: `user-${userId}`,
      createdAt: BigInt(timestampMs()),
    })
    .execute();

  return { tenantId, storeId, deviceId, userId };
}

/** Seeds one note row for `tenant`, returning its id. */
export async function seedNote(db: Kysely<DB>, tenant: TenantFixture): Promise<string> {
  const id = uuid();
  const at = BigInt(timestampMs());

  await db
    .insertInto('notes')
    .values({
      id,
      tenantId: tenant.tenantId,
      storeId: tenant.storeId,
      title: `title-${id}`,
      body: `body-${id}`,
      createdBy: tenant.userId,
      createdAt: at,
      lastEditedBy: tenant.userId,
      lastEditedAt: at,
    })
    .execute();

  return id;
}

/**
 * The op fields a test needs to DECIDE rather than inherit (task 48).
 *
 * Everything here is optional and defaults to what `seedOperation` always used, so the existing
 * `server_seq` walk fixtures are byte-identical to before this interface existed. A test that
 * probes how a COLUMN marshals back has to own the value in that column — a helper that invented
 * `seq`, `payload` or `agent_initiated` itself would be deciding the test's input, and an
 * assertion about a value the fixture chose proves nothing about the value the test meant (T-3).
 */
export interface OperationOverrides {
  /** Per-device counter (05 §2.1). `9` vs `10` is what makes the int8-as-string order invert. */
  readonly seq?: bigint;
  /** Same `entityId` across rows groups them for a `readEntityOps` re-fold read. */
  readonly entityId?: string;
  /** Equal timestamps across rows force `seq` to be the tie-break that decides the order. */
  readonly timestampMs?: bigint;
  /** Written to the `jsonb` column verbatim; the real `pg` driver hands it back PARSED. */
  readonly payload?: unknown;
  /** Also `jsonb` server-side — the same class as `payload`, twelve lines away. */
  readonly location?: unknown;
  /** `boolean` server-side, `0`/`1` client-side — the fraud-model attribution bit (02 §7). */
  readonly agentInitiated?: boolean;
  /**
   * Only the envelope-conformance case sets this. The default `sig-<uuid>` is deliberate filler
   * and is NOT valid base64, so an op carrying it can never satisfy `zSignedOperation` — a case
   * that validates the whole envelope must supply a real one, or it goes red on the signature and
   * an unrelated failure stands in for the claim (T-13).
   */
  readonly signature?: string;
  /** The op `type` (05 §2.1). Task 17's Rule-1 query filters on it, so its cases must own it. */
  readonly type?: string;
  /** The emitting device. Rule 1 turns on `P.deviceId ≠ O.deviceId`, so its cases must own it. */
  readonly deviceId?: string;
}

/**
 * Seeds one `operations` row for `tenant` at an exact `serverSeq` — the op log's server
 * bookkeeping column (05 §2.4), which is what the contiguous-serverSeq walk reads.
 *
 * `serverSeq` is the caller's business: the whole point of the walk is which values are PRESENT,
 * so a helper that allocated them itself would decide the test's input. Takes `bigint` because
 * the column is `bigint` (10-db §5) — passing a JS number here would round silently at 2^53 and
 * quietly weaken any test that probes that boundary.
 *
 * `overrides` is for tests that read the op back through a DECODER and must therefore own what
 * went in (task 48). Omit it and the row is content-free filler exactly as before: the
 * `previous_hash`/`hash` are arbitrary 64-char strings, not a real chain — the walk only reads
 * `server_seq`, and a fake chain here cannot mislead anyone into thinking this file verifies
 * hashes.
 */
export async function seedOperation(
  db: Kysely<DB>,
  tenant: TenantFixture,
  serverSeq: bigint,
  overrides: OperationOverrides = {},
): Promise<string> {
  const id = uuid();
  const at = BigInt(timestampMs());
  const location = overrides.location;

  await db
    .insertInto('operations')
    .values({
      id,
      tenantId: tenant.tenantId,
      storeId: tenant.storeId,
      userId: tenant.userId,
      deviceId: overrides.deviceId ?? tenant.deviceId,
      seq: overrides.seq ?? BigInt(counter),
      type: overrides.type ?? 'note.created',
      entityType: 'note',
      entityId: overrides.entityId ?? uuid(),
      schemaVersion: 1,
      // Serialised here, not handed over as an object: a JSON *string* parameter is what the
      // existing rows have always written into this `jsonb` column, and the point of the tests
      // that read it back is what the DRIVER does on the way OUT, not on the way in.
      payload: JSON.stringify(overrides.payload ?? { title: `t-${id}` }),
      timestampMs: overrides.timestampMs ?? at,
      location: location === undefined || location === null ? null : JSON.stringify(location),
      source: 'ui',
      agentInitiated: overrides.agentInitiated ?? false,
      agentConversationId: null,
      previousHash: '0'.repeat(64),
      hash: id.replace(/-/g, '').padEnd(64, '0').slice(0, 64),
      signature: overrides.signature ?? `sig-${id}`,
      signedCoreJcs: `{"id":"${id}"}`,
      serverSeq,
      receivedAt: at,
    })
    .execute();

  return id;
}
