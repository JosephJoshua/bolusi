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
// from Xendit with the account's own key (`reconcile`), the same path a device's "did they pay yet?"
// takes when no callback came. The callback token is checked first only to turn strangers away.
//
// The charge is checked when the QR is made, by the same rule a device's own payment passes
// (document in this store, account usable here), run as the person asking. A payment that arrives
// later is recorded even if the account was switched off since: the money already moved.
import { createServerProjectionEngine, type DB, type TenantDb } from '@bolusi/db-server';
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
import { XenditRefusal, XenditUnavailable, type XenditPort } from './xendit.js';

/** How often a waiting charge may ask Xendit itself, when a device keeps asking about it. */
const RECHECK_MS = 4_000;

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

export function callbackPath(tenantId: string, accountId: string): string {
  return `/xendit/qr/${tenantId}/${accountId}`;
}

/** The key is sealed to its row: a sealed key moved to another account does not open. */
function sealContext(tenantId: string, accountId: string): string {
  return `qris:${tenantId}:${accountId}`;
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
    .where('qrisConnections.disconnectedAt', 'is', null)
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
      `${ready.qris.publicUrl}${callbackPath(acting.tenantId, accountId)}`,
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
    secretSealed: ready.qris.sealer.seal(secretKey, sealContext(acting.tenantId, accountId)),
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
          disconnectedAt: null,
        }),
      )
      .execute(),
  );
  return connection;
}

/**
 * The account goes back to QRIS by hand. Its key stays, so a QR already on a customer's screen is
 * still confirmed and recorded; no new ones are made.
 */
export async function disconnectAccount(
  deps: QrisServiceDeps,
  acting: ActingUser,
  accountId: string,
): Promise<void> {
  await deps.forTenant(acting.tenantId, async (db) => {
    const account = await loadAccount(db, accountId);
    if (account === undefined) throw new ApiError('NOT_FOUND');
    await requireManages(db, acting, account);
    await db
      .updateTable('qrisConnections')
      .set({ disconnectedAt: deps.now() })
      .where('accountId', '=', accountId)
      .execute();
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
  };
}

function chargeView(charge: ChargeRow, now: number): QrisCharge {
  return {
    id: charge.id,
    status: charge.paidAt !== null ? 'paid' : charge.expiresAt <= now ? 'expired' : 'waiting',
    amount: charge.amount,
    qrString: charge.qrString,
    environment: charge.environment,
    expiresAt: charge.expiresAt,
    paidAt: charge.paidAt,
  };
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

/** The account's Xendit key; a disconnected one's only to confirm QRs it already made. */
async function openKey(
  ready: Ready,
  db: TenantDb,
  tenantId: string,
  accountId: string,
  use: 'newQr' | 'confirm',
) {
  const connection = await db
    .selectFrom('qrisConnections')
    .select(['secretSealed', 'environment', 'disconnectedAt'])
    .where('accountId', '=', accountId)
    .executeTakeFirst();
  if (connection === undefined) return undefined;
  if (use === 'newQr' && connection.disconnectedAt !== null) return undefined;
  return {
    secretKey: ready.qris.sealer.open(connection.secretSealed, sealContext(tenantId, accountId)),
    environment: connection.environment as QrisEnvironment,
  };
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
    const existing = await loadCharge(db, body.id);
    if (existing !== undefined) {
      if (
        existing.deviceId !== device.deviceId ||
        existing.accountId !== body.accountId ||
        existing.amount !== body.amount ||
        existing.document.id !== body.document.id
      ) {
        throw new ApiError('IDEMPOTENCY_CONFLICT');
      }
      return { existing };
    }
    await requirePermission(db, {
      userId: acting.userId,
      tenantId: acting.tenantId,
      storeId,
      permissionId: MONEY_PERMISSION.receive,
    });
    // The rule a payment from this person's device must pass, against the server's records. The op
    // is never signed or stored: only the rule reads it, and the rule reads the fields given here.
    const op = {
      id: body.id,
      tenantId: acting.tenantId,
      storeId,
      userId: acting.userId,
      deviceId: device.deviceId,
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
    } as unknown as SignedOperation;
    const refused = await checkRules(
      db,
      op,
      { storeId },
      ready.opRegistry,
      createAuthorLookup(db, acting.tenantId),
    );
    if (refused !== null) throw new ApiError('CHANGE_REFUSED', { reason: refused.reason });
    const key = await openKey(ready, db, acting.tenantId, body.accountId, 'newQr');
    if (key === undefined) throw new ApiError('QRIS_NOT_CONNECTED');
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
  };
  const saved = await ready.forTenant(acting.tenantId, async (db) => {
    await db
      .insertInto('qrisCharges')
      .values({
        id: charge.id,
        tenantId: acting.tenantId,
        storeId,
        accountId: charge.accountId,
        documentJson: JSON.stringify(charge.document),
        amount: charge.amount,
        xenditQrId: charge.xenditQrId,
        qrString: charge.qrString,
        environment: charge.environment,
        expiresAt: charge.expiresAt,
        requestedBy: charge.requestedBy,
        deviceId: charge.deviceId,
        createdAt: ready.now(),
      })
      // Two answers to one retried request: the first one in is the charge.
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    return loadCharge(db, charge.id);
  });
  return chargeView(saved ?? charge, ready.now());
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
    const found = await loadCharge(db, id, { lock: true });
    if (found === undefined) throw new ApiError('NOT_FOUND');
    requireSameStore(acting, found);
    const ask =
      found.paidAt === null &&
      (found.checkedAt === null || now - found.checkedAt >= RECHECK_MS) &&
      // A QR that expired a while ago can no longer be paid; one more look covers a late answer.
      now <= found.expiresAt + QRIS_TTL_MS;
    if (ask)
      await db.updateTable('qrisCharges').set({ checkedAt: now }).where('id', '=', id).execute();
    return { charge: found, due: ask };
  });
  if (!due) return chargeView(charge, now);
  const settled = await reconcile(ready, acting.tenantId, charge.id).catch((error: unknown) => {
    // A device asking again is the retry; Xendit being slow is not this request's failure.
    if (error instanceof XenditUnavailable || error instanceof XenditRefusal) return null;
    throw error;
  });
  return chargeView(settled ?? charge, ready.now());
}

/** Test mode only: have Xendit pay the QR, as a customer's app would. */
export async function simulateCharge(
  deps: QrisServiceDeps,
  acting: ActingUser,
  id: string,
): Promise<QrisCharge> {
  const ready = readyOrUnavailable(deps);
  const { charge, key } = await ready.forTenant(acting.tenantId, async (db) => {
    const found = await loadCharge(db, id);
    if (found === undefined) throw new ApiError('NOT_FOUND');
    requireSameStore(acting, found);
    await requirePermission(db, {
      userId: acting.userId,
      tenantId: acting.tenantId,
      storeId: found.storeId,
      permissionId: MONEY_PERMISSION.receive,
    });
    if (found.environment !== 'test') throw new ApiError('NOT_FOUND');
    return {
      charge: found,
      key: await openKey(ready, db, acting.tenantId, found.accountId, 'confirm'),
    };
  });
  if (key === undefined) throw new ApiError('QRIS_NOT_CONNECTED');
  if (charge.paidAt === null) {
    try {
      await ready.qris.xendit.simulateQrPayment(key.secretKey, charge.xenditQrId, charge.amount);
    } catch (error) {
      providerError(error);
    }
  }
  const settled = await reconcile(ready, acting.tenantId, charge.id).catch(providerError);
  return chargeView(settled ?? charge, ready.now());
}

// ── the callback ────────────────────────────────────────────────────────────────────────────────

export type CallbackOutcome = 'recorded' | 'ignored' | 'unauthorized' | 'retry';

/**
 * Xendit's `qr.payment` callback for one connected account. The token turns strangers away; the
 * payment itself is then read back from Xendit before anything is recorded.
 */
export async function handleCallback(
  deps: QrisServiceDeps,
  tenantId: string,
  accountId: string,
  token: string | undefined,
  body: unknown,
): Promise<CallbackOutcome> {
  if (deps.qris === undefined || deps.systemKeyStore === undefined) return 'retry';
  const ready = deps as Ready;
  const event = body as { event?: unknown; data?: { reference_id?: unknown; qr_id?: unknown } };

  const chargeId = await ready.forTenant(tenantId, async (db) => {
    const connection = await db
      .selectFrom('qrisConnections')
      .select('callbackTokenHash')
      .where('accountId', '=', accountId)
      .executeTakeFirst();
    if (
      connection === undefined ||
      token === undefined ||
      !timingSafeEqualHex(sha256Hex(token), connection.callbackTokenHash)
    ) {
      return 'unauthorized' as const;
    }
    if (event.event !== 'qr.payment') return null;
    const reference = event.data?.reference_id;
    const qrId = event.data?.qr_id;
    if (typeof reference !== 'string' || typeof qrId !== 'string') return null;
    const charge = await db
      .selectFrom('qrisCharges')
      .select('id')
      .where('xenditQrId', '=', qrId)
      .where('accountId', '=', accountId)
      .executeTakeFirst();
    // A QR this server did not make (the account is also used elsewhere): not ours to record.
    return charge?.id === reference ? charge.id : null;
  });
  if (chargeId === 'unauthorized') return 'unauthorized';
  if (chargeId === null) return 'ignored';
  try {
    const settled = await reconcile(ready, tenantId, chargeId);
    return settled?.paidAt === null || settled === null ? 'ignored' : 'recorded';
  } catch (error) {
    if (error instanceof XenditUnavailable || error instanceof XenditRefusal) return 'retry';
    throw error;
  }
}

// ── recording ───────────────────────────────────────────────────────────────────────────────────

/**
 * Ask Xendit whether the charge's QR was paid, and record the payment if so. Returns the charge as
 * it now stands, or null if it no longer exists.
 */
async function reconcile(ready: Ready, tenantId: string, chargeId: string) {
  const found = await ready.forTenant(tenantId, async (db) => {
    const charge = await loadCharge(db, chargeId);
    if (charge === undefined) return undefined;
    return { charge, key: await openKey(ready, db, tenantId, charge.accountId, 'confirm') };
  });
  if (found === undefined) return null;
  if (found.charge.paidAt !== null || found.key === undefined) return found.charge;
  const payments = await ready.qris.xendit.listQrPayments(
    found.key.secretKey,
    found.charge.xenditQrId,
  );
  const payment = payments.find((p) => p.succeeded);
  if (payment === undefined) return found.charge;
  return recordPayment(ready, tenantId, chargeId, payment.paymentId, payment.amount);
}

async function recordPayment(
  ready: Ready,
  tenantId: string,
  chargeId: string,
  paymentId: string,
  amount: number,
): Promise<ChargeRow | null> {
  const outcome = await ready.tenantPushQueue(tenantId, () =>
    ready.forTenant(tenantId, async (db) => {
      // The push pipeline's lock order: the tenant counter, then the system chain (system-op.ts).
      await lockTenantCounter(db, tenantId);
      const charge = await loadCharge(db, chargeId, { lock: true });
      if (charge === undefined) return null;
      if (charge.paidAt !== null) return { charge, recorded: false };
      const identity = await loadSystemIdentity(db, tenantId, ready.systemKeyStore);
      const now = ready.now();
      const { op } = await appendSystemOp(
        db,
        { crypto: ready.serverCrypto, now: ready.now, newId: ready.newOpLogId },
        {
          tenantId,
          ...identity,
          storeId: charge.storeId,
          type: MONEY_OP.paymentReceived,
          entityType: MONEY_ENTRY_ENTITY,
          entityId: charge.id,
          schemaVersion: 1,
          payload: paymentPayload(charge, amount, paymentId),
          timestamp: now,
        },
      );
      const engine = createServerProjectionEngine<DB>(db, tenantId, ready.projections, {
        batchWatermarks: true,
      });
      await engine.applyPulledOp(op);
      await engine.advancePulledWatermarks();
      await db
        .updateTable('qrisCharges')
        .set({ paymentId, paidAt: now })
        .where('id', '=', chargeId)
        .execute();
      return { charge: { ...charge, paymentId, paidAt: now }, recorded: true };
    }),
  );
  if (outcome === null) return null;
  if (outcome.recorded) {
    announceChange(ready, [{ tenantId, storeId: outcome.charge.storeId }]);
  }
  return outcome.charge;
}
