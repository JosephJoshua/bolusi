// Integrated QRIS through Xendit: connecting a QRIS payment account, making the QR the counter shows,
// and recording the payment once Xendit says it happened (product-scope.md, "Repair payments").
//
// THE PAYMENT IS A SYSTEM RECORD. When Xendit confirms a QR was paid, the money is in the account
// whatever the counter's device is doing, so the server records it itself: a `money.payment_received`
// signed by the tenant's system device (appendSystemOp), folded and announced like a pushed op, so
// every device of the store pulls it as an ordinary payment. Its id is the charge's id, which is
// also the QR's `reference_id` at Xendit, so one QR records at most one payment however often Xendit
// calls back or a device asks.
//
// Nothing is believed from a callback alone. The callback names the QR; the payment is then read back
// from Xendit with the key the QR was made with (`reconcile`), the same path a device's "did they
// pay yet?" takes when no callback came. The callback token is checked first only to turn strangers
// away. Each charge keeps the key and token it was made under, so disconnecting or reconnecting an
// account (even to another Xendit account) never strands a QR already on a customer's screen; the
// key is cleared once the QR is paid or long past its time.
//
// Test mode (an `xnd_development_` key) records its payments too, so a store can try the flow, but
// their reference starts `test:` and only someone who manages the account may have Xendit pay one.
//
// The charge is checked when the QR is made, by the same rule a device's own payment passes
// (document in this store, account usable here), run as the person asking. A payment that arrives
// later is recorded even if the account was switched off since: the money already moved.
//
// ONE OPEN QR PER BILL. While a bill has a QR that can still be paid, no other QR is made for it,
// and the counter's devices take no other method for it (money/qris-hooks.ts): a customer must
// never be able to pay one bill twice by accident. To take it another way the counter cancels the
// QR first. Xendit cannot withdraw a QR, so a cancelled one stays payable until its time; cancelling
// first asks Xendit whether it was paid, and a payment that still comes is recorded like any other
// and shows as money to give back (Kas, "Lebih bayar").
//
// THE SERVER FOLLOWS EVERY QR ITSELF. Xendit's webhook can be lost and the counter's device can be
// closed, so `sweepUnpaidCharges` asks Xendit about each unpaid QR every half minute until it is
// paid or settled as expired: a customer who paid is always recorded.
import { createServerProjectionEngine, type DB, type TenantDb } from '@bolusi/db-server';
import { sql } from 'kysely';
import {
  MONEY_ENTRY_ENTITY,
  MONEY_OP,
  MONEY_PERMISSION,
  accountVisibleTo,
  centralStoreIds,
  paymentAccountRef,
  type MoneyDocument,
} from '@bolusi/modules/money';
import {
  GENESIS_PREVIOUS_HASH,
  QRIS_TTL_MS,
  type QrisCharge,
  type QrisChargeBody,
  type QrisConnection,
  type QrisEnvironment,
  type SignedOperation,
} from '@bolusi/schemas';
import type { CryptoPort, ProjectionRegistry } from '@bolusi/core';
import type { ForTenant } from '@bolusi/db-server';

import type { ActingUser } from '../auth/acting-user.js';
import type { AuthDirectory } from '../auth/directory.js';
import { createAuthorLookup } from '../oplog/steps/permission.js';
import { checkRules } from '../oplog/steps/rules.js';
import { appendSystemOp } from '../oplog/system-op.js';
import { lockTenantCounter } from '../oplog/server-seq.js';
import type { OpRegistry } from '../oplog/types.js';
import { requirePermission } from '../auth/permissions.js';
import { sha256Hex, timingSafeEqualHex } from '../crypto/index.js';
import { ApiError } from '../errors.js';
import { announceChange, type AnnounceDeps } from '../realtime/announce.js';
import { loadSystemIdentity, type SystemKeyStore } from '../sync/conflict-wiring.js';
import type { TenantQueue } from '../sync/tenant-queue.js';
import type { SecretSealer } from './seal.js';
import {
  XenditRefusal,
  XenditUnavailable,
  type XenditPort,
  type XenditQrPayment,
} from './xendit.js';

/** How often a waiting charge may ask Xendit itself, when a device keeps asking about it. */
const RECHECK_MS = 4_000;

/** How often the server's own sweep asks Xendit about an unpaid charge. */
export const SWEEP_EVERY_MS = 30_000;
const SWEEP_RECHECK_MS = 20_000;

/**
 * A QR past its time still waits this long, and for one look at Xendit after it, before it is said
 * to be expired: a customer who paid in its last second must not be asked to pay again.
 */
const SETTLE_MS = 10_000;

/** What integrated QRIS needs from the deployment. Absent ⇒ every QRIS route is 503. */
export interface QrisConfig {
  readonly sealer: SecretSealer;
  readonly xendit: XenditPort;
  /** This server's public origin, where Xendit posts payments (`https://api.example.com`). */
  readonly publicUrl: string;
}

export interface QrisServiceDeps extends AnnounceDeps {
  readonly forTenant: ForTenant;
  readonly tenantPushQueue: TenantQueue;
  readonly now: () => number;
  readonly serverCrypto: CryptoPort;
  readonly newOpLogId: () => string;
  readonly opRegistry: OpRegistry;
  readonly projections: ProjectionRegistry<DB>;
  readonly systemKeyStore?: SystemKeyStore | undefined;
  readonly qris?: QrisConfig | undefined;
}

/** The sweep also lists unpaid charges across tenants (migration 0035's definer lookup). */
export interface QrisSweepDeps extends QrisServiceDeps {
  readonly authDirectory: Pick<AuthDirectory, 'findUnpaidQrisCharges'>;
}

interface Ready extends QrisServiceDeps {
  readonly qris: QrisConfig;
  readonly systemKeyStore: SystemKeyStore;
}

/** Both the provider and the system signer are needed: a payment must be recordable when it lands. */
export function readyOrUnavailable(deps: QrisServiceDeps): Ready {
  if (deps.qris === undefined || deps.systemKeyStore === undefined) {
    throw new ApiError('QRIS_UNAVAILABLE');
  }
  return deps as Ready;
}

function providerError(error: unknown): never {
  if (error instanceof XenditRefusal) {
    if (error.reason === 'amountNotAllowed') throw new ApiError('QRIS_AMOUNT_REFUSED');
    if (error.reason === 'keyInvalid' || error.reason === 'keyNotAllowed') {
      throw new ApiError('QRIS_KEY_REFUSED', { reason: error.reason });
    }
  }
  if (error instanceof XenditRefusal || error instanceof XenditUnavailable) {
    throw new ApiError('QRIS_UNAVAILABLE');
  }
  throw error;
}

/**
 * One webhook per tenant, not per account: a Xendit account has a single QR webhook, and two
 * payment accounts may share one Xendit account. The QR a callback names says which charge it is.
 */
export function callbackPath(tenantId: string): string {
  return `/xendit/qr/${tenantId}`;
}

/** A key is sealed to its row: a sealed key copied onto another row does not open. */
function sealContext(table: 'connection' | 'charge', tenantId: string, id: string): string {
  return `qris-${table}:${tenantId}:${id}`;
}

/** The system device must be able to sign the payment before a customer is shown a QR to pay. */
async function requireRecordable(ready: Ready, db: TenantDb, tenantId: string): Promise<void> {
  try {
    await loadSystemIdentity(db, tenantId, ready.systemKeyStore);
  } catch {
    throw new ApiError('QRIS_UNAVAILABLE');
  }
}

// ── accounts ────────────────────────────────────────────────────────────────────────────────────

interface AccountRow {
  readonly id: string;
  readonly storeId: string | null;
  readonly storeIds: readonly string[];
  readonly kind: string;
  readonly active: boolean;
}

async function loadAccount(db: TenantDb, accountId: string): Promise<AccountRow | undefined> {
  const row = await db
    .selectFrom('moneyAccounts')
    .select(['id', 'storeId', 'storeIdsJson', 'kind', 'active'])
    .where('id', '=', accountId)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    id: row.id,
    storeId: row.storeId,
    storeIds: centralStoreIds(row.storeIdsJson),
    kind: row.kind,
    active: row.active === 1,
  };
}

/**
 * Connecting an account is setting it up: a store's QRIS by whoever manages that store's accounts,
 * from a device of that store; a central one by whoever manages the franchise's accounts.
 */
async function requireManages(db: TenantDb, acting: ActingUser, account: AccountRow) {
  if (account.storeId !== null && acting.deviceStoreId !== null) {
    if (account.storeId !== acting.deviceStoreId) throw new ApiError('NOT_FOUND');
  }
  await requirePermission(db, {
    userId: acting.userId,
    tenantId: acting.tenantId,
    storeId: account.storeId ?? acting.deviceStoreId,
    permissionId:
      account.storeId === null
        ? MONEY_PERMISSION.manageCentralAccounts
        : MONEY_PERMISSION.manageAccounts,
  });
}

/** The connected accounts this device's store can take payments with (all of them off a device). */
export async function listConnections(db: TenantDb, acting: ActingUser): Promise<QrisConnection[]> {
  const rows = await db
    .selectFrom('qrisConnections')
    .innerJoin('moneyAccounts', 'moneyAccounts.id', 'qrisConnections.accountId')
    .select([
      'qrisConnections.accountId',
      'qrisConnections.environment',
      'qrisConnections.connectedAt',
      'moneyAccounts.storeId',
      'moneyAccounts.storeIdsJson',
    ])
    .execute();
  return rows
    .filter(
      (row) =>
        acting.deviceStoreId === null ||
        accountVisibleTo(
          { storeId: row.storeId, storeIds: centralStoreIds(row.storeIdsJson) },
          acting.deviceStoreId,
        ),
    )
    .map((row) => ({
      accountId: row.accountId,
      environment: row.environment as QrisEnvironment,
      connectedAt: Number(row.connectedAt),
    }));
}

export async function connectAccount(
  deps: QrisServiceDeps,
  acting: ActingUser,
  accountId: string,
  secretKey: string,
): Promise<QrisConnection> {
  const ready = readyOrUnavailable(deps);
  await ready.forTenant(acting.tenantId, async (db) => {
    const account = await loadAccount(db, accountId);
    if (account === undefined) throw new ApiError('NOT_FOUND');
    await requireManages(db, acting, account);
    if (account.kind !== 'qris') throw new ApiError('NOT_FOUND');
  });

  // Outside the transaction: an answer from Xendit can take seconds.
  let hook;
  try {
    hook = await ready.qris.xendit.setQrWebhook(
      secretKey,
      `${ready.qris.publicUrl}${callbackPath(acting.tenantId)}`,
    );
  } catch (error) {
    providerError(error);
  }

  const connection: QrisConnection = {
    accountId,
    environment: hook.environment,
    connectedAt: ready.now(),
  };
  const row = {
    accountId,
    tenantId: acting.tenantId,
    secretSealed: ready.qris.sealer.seal(
      secretKey,
      sealContext('connection', acting.tenantId, accountId),
    ),
    callbackTokenHash: sha256Hex(hook.callbackToken),
    environment: hook.environment,
    connectedBy: acting.userId,
    connectedAt: connection.connectedAt,
  };
  await ready.forTenant(acting.tenantId, (db) =>
    db
      .insertInto('qrisConnections')
      .values(row)
      .onConflict((oc) =>
        oc.column('accountId').doUpdateSet({
          secretSealed: row.secretSealed,
          callbackTokenHash: row.callbackTokenHash,
          environment: row.environment,
          connectedBy: row.connectedBy,
          connectedAt: row.connectedAt,
        }),
      )
      .execute(),
  );
  return connection;
}

/** The account goes back to QRIS by hand. A QR already shown keeps its own key and still records. */
export async function disconnectAccount(
  deps: QrisServiceDeps,
  acting: ActingUser,
  accountId: string,
): Promise<void> {
  await deps.forTenant(acting.tenantId, async (db) => {
    const account = await loadAccount(db, accountId);
    if (account === undefined) throw new ApiError('NOT_FOUND');
    await requireManages(db, acting, account);
    await db.deleteFrom('qrisConnections').where('accountId', '=', accountId).execute();
  });
}

// ── charges ─────────────────────────────────────────────────────────────────────────────────────

interface ChargeRow {
  readonly id: string;
  readonly storeId: string;
  readonly accountId: string;
  readonly document: MoneyDocument;
  readonly amount: number;
  readonly xenditQrId: string;
  readonly qrString: string;
  readonly environment: QrisEnvironment;
  readonly expiresAt: number;
  readonly requestedBy: string;
  readonly deviceId: string;
  readonly checkedAt: number | null;
  readonly paymentId: string | null;
  readonly paidAt: number | null;
  /** The counter gave up on the QR; it stays payable until `expiresAt` (see the file header). */
  readonly cancelledAt: number | null;
  /** The account's key when the QR was made (see the file header); cleared once it is done with. */
  readonly secretSealed: string | null;
  readonly callbackTokenHash: string;
}

async function loadCharge(
  db: TenantDb,
  id: string,
  options: { readonly lock?: boolean } = {},
): Promise<ChargeRow | undefined> {
  const query = db.selectFrom('qrisCharges').selectAll().where('id', '=', id);
  const row = await (options.lock === true ? query.forUpdate() : query).executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    id: row.id,
    storeId: row.storeId,
    accountId: row.accountId,
    document: JSON.parse(row.documentJson) as MoneyDocument,
    amount: Number(row.amount),
    xenditQrId: row.xenditQrId,
    qrString: row.qrString,
    environment: row.environment as QrisEnvironment,
    expiresAt: Number(row.expiresAt),
    requestedBy: row.requestedBy,
    deviceId: row.deviceId,
    checkedAt: row.checkedAt === null ? null : Number(row.checkedAt),
    paymentId: row.paymentId,
    paidAt: row.paidAt === null ? null : Number(row.paidAt),
    cancelledAt: row.cancelledAt === null ? null : Number(row.cancelledAt),
    secretSealed: row.secretSealed,
    callbackTokenHash: row.callbackTokenHash,
  };
}

/** Whether a stored charge is the one this request asks for (a retry), not another one. */
function sameRequest(
  charge: ChargeRow,
  body: QrisChargeBody,
  device: { readonly deviceId: string },
): boolean {
  return (
    charge.deviceId === device.deviceId &&
    charge.accountId === body.accountId &&
    charge.amount === body.amount &&
    charge.document.id === body.document.id
  );
}

/**
 * The key to ask Xendit about a charge with: the one it was made under, or, once that is cleared (a
 * late callback for a QR long expired), the account's current one.
 */
async function chargeKey(ready: Ready, tenantId: string, charge: ChargeRow): Promise<string> {
  if (charge.secretSealed !== null) {
    return ready.qris.sealer.open(charge.secretSealed, sealContext('charge', tenantId, charge.id));
  }
  const connection = await ready.forTenant(tenantId, (db) =>
    connectionOf(ready, db, tenantId, charge.accountId),
  );
  if (connection === undefined) throw new XenditRefusal('keyInvalid');
  return connection.secretKey;
}

/** Waiting until Xendit was asked after the QR's time and showed no payment (`SETTLE_MS`). */
function expired(charge: ChargeRow, now: number): boolean {
  if (charge.paidAt !== null || now <= charge.expiresAt) return false;
  if (now > charge.expiresAt + QRIS_TTL_MS) return true;
  return charge.checkedAt !== null && charge.checkedAt >= charge.expiresAt + SETTLE_MS;
}

/** A QR the customer may still pay and the counter has not given up on: the bill waits for it. */
function open(charge: ChargeRow, now: number): boolean {
  return charge.paidAt === null && charge.cancelledAt === null && !expired(charge, now);
}

function chargeView(charge: ChargeRow, now: number): QrisCharge {
  return {
    id: charge.id,
    status:
      charge.paidAt !== null
        ? 'paid'
        : charge.cancelledAt !== null
          ? 'cancelled'
          : expired(charge, now)
            ? 'expired'
            : 'waiting',
    amount: charge.amount,
    qrString: charge.qrString,
    environment: charge.environment,
    expiresAt: charge.expiresAt,
    paidAt: charge.paidAt,
    cancelledAt: charge.cancelledAt,
  };
}

/** The bill's other open QR in this store, if any: a second one is never made beside it. */
async function openChargeFor(
  db: TenantDb,
  storeId: string,
  documentId: string,
  except: string,
  now: number,
): Promise<ChargeRow | undefined> {
  const rows = await db
    .selectFrom('qrisCharges')
    .select('id')
    .where('documentId', '=', documentId)
    .where('storeId', '=', storeId)
    .where('paidAt', 'is', null)
    .where('cancelledAt', 'is', null)
    .where('id', '!=', except)
    .where('expiresAt', '>', String(now - QRIS_TTL_MS))
    .execute();
  for (const row of rows) {
    const charge = await loadCharge(db, row.id);
    if (charge !== undefined && open(charge, now)) return charge;
  }
  return undefined;
}

/** Two devices making a QR for one bill at once: one at a time, so only one QR is ever open. */
async function lockDocument(db: TenantDb, documentId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`qris-document:${documentId}`}, 0))`.execute(
    db,
  );
}

/** The payment this charge will record, as the device itself would have written it. */
function paymentPayload(
  charge: Pick<ChargeRow, 'document' | 'accountId'>,
  amount: number,
  ref: string,
) {
  return {
    document: charge.document,
    account: paymentAccountRef(charge.accountId),
    amount,
    reference: ref,
    tendered: null,
  };
}

/** A charge is the person's to see from a device of the store it was made in. */
function requireSameStore(acting: ActingUser, charge: ChargeRow): void {
  if (acting.deviceStoreId !== null && acting.deviceStoreId !== charge.storeId) {
    throw new ApiError('NOT_FOUND');
  }
}

/** The connected account's Xendit key and callback token, for a new QR. */
async function connectionOf(ready: Ready, db: TenantDb, tenantId: string, accountId: string) {
  const connection = await db
    .selectFrom('qrisConnections')
    .select(['secretSealed', 'callbackTokenHash', 'environment'])
    .where('accountId', '=', accountId)
    .executeTakeFirst();
  if (connection === undefined) return undefined;
  return {
    secretKey: ready.qris.sealer.open(
      connection.secretSealed,
      sealContext('connection', tenantId, accountId),
    ),
    callbackTokenHash: connection.callbackTokenHash,
    environment: connection.environment as QrisEnvironment,
  };
}

/** Taking a payment: the counter's permission in the charge's store. */
function requireReceives(db: TenantDb, acting: ActingUser, storeId: string): Promise<void> {
  return requirePermission(db, {
    userId: acting.userId,
    tenantId: acting.tenantId,
    storeId,
    permissionId: MONEY_PERMISSION.receive,
  });
}

/**
 * A QR for one payment, made by a device of the store taking it. The same id again (a retry after
 * a lost answer) returns the QR already made rather than a second one.
 */
export async function createCharge(
  deps: QrisServiceDeps,
  acting: ActingUser,
  device: { readonly deviceId: string; readonly storeId: string | null },
  body: QrisChargeBody,
): Promise<QrisCharge> {
  const ready = readyOrUnavailable(deps);
  const storeId = device.storeId;
  if (storeId === null) throw new ApiError('NOT_FOUND');

  const checked = await ready.forTenant(acting.tenantId, async (db) => {
    await requireReceives(db, acting, storeId);
    const existing = await loadCharge(db, body.id);
    if (existing !== undefined) {
      if (!sameRequest(existing, body, device)) throw new ApiError('IDEMPOTENCY_CONFLICT');
      return { existing };
    }
    // The rule a payment from this person's device must pass, against the server's records. The op
    // is never signed or stored: it is what the device would have written, for the rule to read.
    const op: SignedOperation = {
      id: body.id,
      tenantId: acting.tenantId,
      storeId,
      userId: acting.userId,
      deviceId: device.deviceId,
      seq: 1,
      type: MONEY_OP.paymentReceived,
      entityType: MONEY_ENTRY_ENTITY,
      entityId: body.id,
      schemaVersion: 1,
      payload: paymentPayload(
        { document: body.document, accountId: body.accountId },
        body.amount,
        'xendit',
      ),
      timestamp: ready.now(),
      location: null,
      source: 'ui',
      agentInitiated: false,
      agentConversationId: null,
      previousHash: GENESIS_PREVIOUS_HASH,
      hash: GENESIS_PREVIOUS_HASH,
      signature: '',
    };
    const refused = await checkRules(
      db,
      op,
      { storeId },
      ready.opRegistry,
      createAuthorLookup(db, acting.tenantId),
      ready.serverCrypto,
      op.timestamp,
    );
    if (refused !== null) throw new ApiError('CHANGE_REFUSED', { reason: refused.reason });
    const key = await connectionOf(ready, db, acting.tenantId, body.accountId);
    if (key === undefined) throw new ApiError('QRIS_NOT_CONNECTED');
    const other = await openChargeFor(db, storeId, body.document.id, body.id, ready.now());
    if (other !== undefined) throw new ApiError('QRIS_CHARGE_OPEN', { chargeId: other.id });
    await requireRecordable(ready, db, acting.tenantId);
    return { key };
  });
  if ('existing' in checked) return chargeView(checked.existing, ready.now());

  const expiresAt = ready.now() + QRIS_TTL_MS;
  let qr;
  try {
    qr = await ready.qris.xendit.createDynamicQr(checked.key.secretKey, {
      referenceId: body.id,
      amount: body.amount,
      expiresAt,
    });
  } catch (error) {
    providerError(error);
  }

  const charge: ChargeRow = {
    id: body.id,
    storeId,
    accountId: body.accountId,
    document: body.document,
    amount: body.amount,
    xenditQrId: qr.qrId,
    qrString: qr.qrString,
    environment: checked.key.environment,
    expiresAt,
    requestedBy: acting.userId,
    deviceId: device.deviceId,
    checkedAt: null,
    paymentId: null,
    paidAt: null,
    cancelledAt: null,
    secretSealed: ready.qris.sealer.seal(
      checked.key.secretKey,
      sealContext('charge', acting.tenantId, body.id),
    ),
    callbackTokenHash: checked.key.callbackTokenHash,
  };
  const saved = await ready.forTenant(acting.tenantId, async (db) => {
    // Checked again under the bill's lock: another device may have made one while Xendit answered.
    // The QR just made is then never shown, and expires.
    await lockDocument(db, body.document.id);
    const other = await openChargeFor(db, storeId, body.document.id, body.id, ready.now());
    if (other !== undefined) throw new ApiError('QRIS_CHARGE_OPEN', { chargeId: other.id });
    // Keys of QRs long past their time are no longer needed: a late callback asks with the
    // account's current key.
    await db
      .updateTable('qrisCharges')
      .set({ secretSealed: null })
      .where('secretSealed', 'is not', null)
      .where('paidAt', 'is', null)
      .where('expiresAt', '<', String(ready.now() - QRIS_TTL_MS))
      .execute();
    await db
      .insertInto('qrisCharges')
      .values({
        id: charge.id,
        tenantId: acting.tenantId,
        storeId,
        accountId: charge.accountId,
        documentJson: JSON.stringify(charge.document),
        documentId: charge.document.id,
        amount: charge.amount,
        xenditQrId: charge.xenditQrId,
        qrString: charge.qrString,
        environment: charge.environment,
        expiresAt: charge.expiresAt,
        requestedBy: charge.requestedBy,
        deviceId: charge.deviceId,
        secretSealed: charge.secretSealed,
        callbackTokenHash: charge.callbackTokenHash,
        createdAt: ready.now(),
      })
      // Two requests with one id at once: the first one in is the charge (the other QR is never
      // shown, and expires), and only a retry of that same request gets it back.
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    return loadCharge(db, charge.id);
  });
  // Not stored (the id is another tenant's charge) or stored by another request with this id.
  if (saved === undefined || !sameRequest(saved, body, device)) {
    throw new ApiError('IDEMPOTENCY_CONFLICT');
  }
  return chargeView(saved, ready.now());
}

/**
 * Where a charge stands. A device asks while its QR is on screen; when no callback has come, this
 * also asks Xendit (at most every few seconds per charge), so a payment shows even if Xendit never
 * reaches the webhook.
 */
export async function chargeStatus(
  deps: QrisServiceDeps,
  acting: ActingUser,
  id: string,
): Promise<QrisCharge> {
  const ready = readyOrUnavailable(deps);
  const now = ready.now();
  const { charge, due } = await ready.forTenant(acting.tenantId, async (db) => {
    const found = await loadCharge(db, id);
    if (found === undefined) throw new ApiError('NOT_FOUND');
    requireSameStore(acting, found);
    await requireReceives(db, acting, found.storeId);
    // A cancelled QR is no longer the counter's to wait for; the server's sweep still follows it.
    if (found.cancelledAt !== null) return { charge: found, due: false };
    return { charge: found, due: await claimCheck(db, found, now, RECHECK_MS) };
  });
  if (!due) return chargeView(charge, now);
  return chargeView(await look(ready, acting.tenantId, charge, now), ready.now());
}

/**
 * Claim the next look at Xendit for a charge: at most one asker per `recheckMs`, so two devices
 * (or a device and the sweep) asking at once ask Xendit once. Past the QR's time, the look that
 * settles it is always due. Nothing is due once it is paid or can no longer be paid.
 */
async function claimCheck(
  db: TenantDb,
  charge: ChargeRow,
  now: number,
  recheckMs: number,
): Promise<boolean> {
  // A QR that expired a while ago can no longer be paid; a callback still records a late one.
  if (charge.paidAt !== null || now > charge.expiresAt + QRIS_TTL_MS) return false;
  const settles = charge.expiresAt + SETTLE_MS;
  // Settled: asked after its time and its last second, and not paid.
  if (charge.checkedAt !== null && charge.checkedAt >= settles) return false;
  const claimed = await db
    .updateTable('qrisCharges')
    .set({ checkedAt: now })
    .where('id', '=', charge.id)
    .where((eb) =>
      eb.or([
        eb('checkedAt', 'is', null),
        eb('checkedAt', '<=', String(now - recheckMs)),
        ...(now >= settles ? [eb('checkedAt', '<', String(settles))] : []),
      ]),
    )
    .executeTakeFirst();
  return claimed.numUpdatedRows > 0n;
}

/**
 * Ask Xendit about a charge whose look was claimed at `now`, recording its payment if it was paid.
 * Xendit being slow is not the asker's failure: the charge is returned as it was, and the claim
 * given back, since a look that did not happen must not count as the one that says it expired.
 */
async function look(
  ready: Ready,
  tenantId: string,
  charge: ChargeRow,
  now: number,
): Promise<ChargeRow> {
  const looked = { ...charge, checkedAt: now };
  try {
    return (await reconcile(ready, tenantId, looked)) ?? looked;
  } catch (error) {
    if (error instanceof XenditUnavailable || error instanceof XenditRefusal) {
      await ready.forTenant(tenantId, (db) =>
        db
          .updateTable('qrisCharges')
          .set({ checkedAt: charge.checkedAt })
          .where('id', '=', charge.id)
          .where('checkedAt', '=', String(now))
          .execute(),
      );
      return charge;
    }
    throw error;
  }
}

/**
 * The bill's QRs in this store that can still be paid and were not cancelled: a device about to
 * take the bill sees a QR another device (or itself, before a restart) showed.
 */
export async function openCharges(
  deps: QrisServiceDeps,
  acting: ActingUser,
  documentId: string,
): Promise<QrisCharge[]> {
  const ready = readyOrUnavailable(deps);
  const storeId = acting.deviceStoreId;
  if (storeId === null) throw new ApiError('NOT_FOUND');
  const now = ready.now();
  return ready.forTenant(acting.tenantId, async (db) => {
    await requireReceives(db, acting, storeId);
    const rows = await db
      .selectFrom('qrisCharges')
      .select('id')
      .where('documentId', '=', documentId)
      .where('storeId', '=', storeId)
      .where('paidAt', 'is', null)
      .where('cancelledAt', 'is', null)
      .where('expiresAt', '>', String(now - QRIS_TTL_MS))
      .execute();
    const charges = await Promise.all(rows.map((row) => loadCharge(db, row.id)));
    return charges
      .filter((charge): charge is ChargeRow => charge !== undefined && open(charge, now))
      .map((charge) => chargeView(charge, now));
  });
}

/**
 * The counter gives up on a QR to take the bill another way. Xendit is asked first, so a QR the
 * customer already paid is said to be paid rather than cancelled (and the counter takes nothing
 * more). If Xendit cannot be asked, it is cancelled anyway: the customer is at the counter, and a
 * payment that still comes is recorded and shows as money to give back.
 */
export async function cancelCharge(
  deps: QrisServiceDeps,
  acting: ActingUser,
  id: string,
): Promise<QrisCharge> {
  const ready = readyOrUnavailable(deps);
  const charge = await ready.forTenant(acting.tenantId, async (db) => {
    const found = await loadCharge(db, id);
    if (found === undefined) throw new ApiError('NOT_FOUND');
    requireSameStore(acting, found);
    await requireReceives(db, acting, found.storeId);
    return found;
  });
  if (charge.paidAt !== null || charge.cancelledAt !== null) {
    return chargeView(charge, ready.now());
  }
  const now = ready.now();
  const checked = await look(ready, acting.tenantId, charge, now);
  if (checked.paidAt !== null) return chargeView(checked, ready.now());
  const cancelled = await ready.forTenant(acting.tenantId, async (db) => {
    await db
      .updateTable('qrisCharges')
      .set({ cancelledAt: now, cancelledBy: acting.userId })
      .where('id', '=', id)
      .where('paidAt', 'is', null)
      .where('cancelledAt', 'is', null)
      .execute();
    return loadCharge(db, id);
  });
  return chargeView(cancelled ?? checked, ready.now());
}

/**
 * The server's own look at every unpaid QR (see the file header), run every `SWEEP_EVERY_MS`. Each
 * charge is claimed like a device's look, so the sweep and a device asking never ask Xendit twice.
 * One tenant's trouble (Xendit refusing its key) never stops the others.
 */
export async function sweepUnpaidCharges(deps: QrisSweepDeps): Promise<void> {
  if (deps.qris === undefined || deps.systemKeyStore === undefined) return;
  const ready = deps as QrisSweepDeps & Ready;
  const now = ready.now();
  const due = await ready.authDirectory.findUnpaidQrisCharges(now - QRIS_TTL_MS, SETTLE_MS);
  for (const { tenantId, chargeId } of due) {
    try {
      const charge = await ready.forTenant(tenantId, async (db) => {
        const found = await loadCharge(db, chargeId);
        if (found === undefined) return undefined;
        return (await claimCheck(db, found, now, SWEEP_RECHECK_MS)) ? found : undefined;
      });
      if (charge !== undefined) await look(ready, tenantId, charge, now);
    } catch (error) {
      console.error('qris sweep: charge check failed', { tenantId, chargeId, error });
    }
  }
}

/** Runs the sweep every `everyMs` until stopped; one run at a time. */
export function startQrisSweep(deps: QrisSweepDeps, everyMs = SWEEP_EVERY_MS): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    sweepUnpaidCharges(deps)
      .catch((error: unknown) => console.error('qris sweep failed', error))
      .finally(() => {
        running = false;
      });
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Test mode only: have Xendit pay the QR, as a customer's app would. Someone who manages the account
 * only: in a real store a cashier must not be able to mark a servisan paid with play money.
 */
export async function simulateCharge(
  deps: QrisServiceDeps,
  acting: ActingUser,
  id: string,
): Promise<QrisCharge> {
  const ready = readyOrUnavailable(deps);
  const charge = await ready.forTenant(acting.tenantId, async (db) => {
    const found = await loadCharge(db, id);
    if (found === undefined) throw new ApiError('NOT_FOUND');
    requireSameStore(acting, found);
    const account = await loadAccount(db, found.accountId);
    if (account === undefined) throw new ApiError('NOT_FOUND');
    await requireManages(db, acting, account);
    if (found.environment !== 'test') throw new ApiError('NOT_FOUND');
    return found;
  });
  if (charge.paidAt === null) {
    try {
      await ready.qris.xendit.simulateQrPayment(
        await chargeKey(ready, acting.tenantId, charge),
        charge.xenditQrId,
        charge.amount,
      );
    } catch (error) {
      providerError(error);
    }
  }
  const settled = await reconcile(ready, acting.tenantId, charge).catch(providerError);
  return chargeView(settled ?? charge, ready.now());
}

// ── the callback ────────────────────────────────────────────────────────────────────────────────

export type CallbackOutcome = 'recorded' | 'ignored' | 'unauthorized' | 'retry';

/**
 * Xendit's `qr.payment` callback. The QR it names says which charge, and so which callback token,
 * it must carry; the payment itself is then read back from Xendit before anything is recorded.
 * A genuine callback for a payment Xendit does not show yet answers `retry`, so Xendit calls again.
 */
export async function handleCallback(
  deps: QrisServiceDeps,
  tenantId: string,
  token: string | undefined,
  body: unknown,
): Promise<CallbackOutcome> {
  if (deps.qris === undefined || deps.systemKeyStore === undefined) return 'retry';
  const ready = deps as Ready;
  // Without a token nothing is read or looked up.
  if (token === undefined || token === '') return 'unauthorized';
  const event = (typeof body === 'object' && body !== null ? body : {}) as {
    event?: unknown;
    data?: { reference_id?: unknown; qr_id?: unknown };
  };
  const qrId = event.data?.qr_id;
  // Not a QR payment, or not one this server made (the Xendit account may serve other systems):
  // nothing here to record, and nothing for Xendit to retry.
  if (event.event !== 'qr.payment' || typeof qrId !== 'string') return 'ignored';

  // A QR this server does not know and a token that is not this QR's answer alike, so a stranger
  // cannot learn which QR ids are real.
  const presented = sha256Hex(token);
  const matches = (hashes: readonly string[]) =>
    hashes.reduce((any, hash) => timingSafeEqualHex(presented, hash) || any, false);

  const found = await ready.forTenant(tenantId, async (db) => {
    const id = await db
      .selectFrom('qrisCharges')
      .select('id')
      .where('xenditQrId', '=', qrId)
      .executeTakeFirst();
    const charge = id === undefined ? undefined : await loadCharge(db, id.id);
    if (charge === undefined) {
      // Another system's QR on a Xendit account connected here: let go, for a caller holding one of
      // this tenant's tokens.
      const all = await db.selectFrom('qrisConnections').select('callbackTokenHash').execute();
      return { charge: undefined, genuine: matches(all.map((row) => row.callbackTokenHash)) };
    }
    // The token the QR was made under, or the account's current one (an owner rotated the token in
    // Xendit and reconnected while this QR was on screen).
    const current = await db
      .selectFrom('qrisConnections')
      .select('callbackTokenHash')
      .where('accountId', '=', charge.accountId)
      .executeTakeFirst();
    const hashes = [
      charge.callbackTokenHash,
      ...(current === undefined ? [] : [current.callbackTokenHash]),
    ];
    return { charge, genuine: matches(hashes) };
  });
  if (!found.genuine) return 'unauthorized';
  if (found.charge === undefined) return 'ignored';
  if (event.data?.reference_id !== found.charge.id) return 'ignored';
  try {
    const settled = await reconcile(ready, tenantId, found.charge);
    if (settled === null) return 'ignored';
    // Xendit says it was paid but does not list it yet: have Xendit call again, rather than leave
    // the payment to a device that may no longer be asking.
    return settled.paidAt !== null ? 'recorded' : 'retry';
  } catch (error) {
    if (error instanceof XenditUnavailable || error instanceof XenditRefusal) return 'retry';
    throw error;
  }
}

// ── recording ───────────────────────────────────────────────────────────────────────────────────

/**
 * Ask Xendit whether the charge's QR was paid, with the key it was made with, and record the
 * payment if so. Returns the charge as it now stands, or null if it no longer exists.
 */
async function reconcile(
  ready: Ready,
  tenantId: string,
  charge: ChargeRow,
): Promise<ChargeRow | null> {
  if (charge.paidAt !== null) return charge;
  const payments = await ready.qris.xendit.listQrPayments(
    await chargeKey(ready, tenantId, charge),
    charge.xenditQrId,
  );
  const payment = payments.find((p) => p.succeeded);
  if (payment === undefined) return charge;
  return recordPayment(ready, tenantId, charge.id, payment);
}

async function recordPayment(
  ready: Ready,
  tenantId: string,
  chargeId: string,
  payment: XenditQrPayment,
): Promise<ChargeRow | null> {
  const { paymentId, amount } = payment;
  const outcome = await ready.tenantPushQueue(tenantId, () =>
    ready.forTenant(tenantId, async (db) => {
      // The push pipeline's lock order: the tenant counter, then the system chain (system-op.ts).
      await lockTenantCounter(db, tenantId);
      const charge = await loadCharge(db, chargeId, { lock: true });
      if (charge === undefined) return null;
      if (charge.paidAt !== null) return { charge, recorded: false };
      const identity = await loadSystemIdentity(db, tenantId, ready.systemKeyStore);
      // When the customer paid, so a late confirmation lands on the day (and the Tutup kas) it
      // happened; never ahead of the server's clock.
      const now = ready.now();
      const paidAt = Math.min(payment.paidAt ?? now, now);
      // The charge id was free when the QR was made; if a device has since used it, the payment
      // still lands, under an id of its own.
      const taken = await db
        .selectFrom('moneyEntries')
        .select('id')
        .where('id', '=', charge.id)
        .executeTakeFirst();
      const { op } = await appendSystemOp(
        db,
        { crypto: ready.serverCrypto, now: ready.now, newId: ready.newOpLogId },
        {
          tenantId,
          ...identity,
          storeId: charge.storeId,
          type: MONEY_OP.paymentReceived,
          entityType: MONEY_ENTRY_ENTITY,
          entityId: taken === undefined ? charge.id : ready.newOpLogId(),
          schemaVersion: 1,
          payload: paymentPayload(
            charge,
            amount,
            charge.environment === 'test' ? `test:${paymentId}` : paymentId,
          ),
          timestamp: paidAt,
        },
      );
      const engine = createServerProjectionEngine<DB>(db, tenantId, ready.projections, {
        batchWatermarks: true,
      });
      await engine.applyPulledOp(op);
      await engine.advancePulledWatermarks();
      await db
        .updateTable('qrisCharges')
        .set({ paymentId, paidAt, secretSealed: null })
        .where('id', '=', chargeId)
        .execute();
      return { charge: { ...charge, paymentId, paidAt, secretSealed: null }, recorded: true };
    }),
  );
  if (outcome === null) return null;
  if (outcome.recorded) {
    announceChange(ready, [{ tenantId, storeId: outcome.charge.storeId }]);
  }
  return outcome.charge;
}
