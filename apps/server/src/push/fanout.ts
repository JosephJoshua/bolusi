// Fan-out: who a push reaches, and dispatch (api/04-push §3, §6). This is the SEC-RT-04 push leg —
// fan-out NEVER exceeds pull scope (api/01-sync §4.3): a device must not learn, even via a data-only
// `sync` wake, that another tenant or an out-of-scope store has activity (security-guide §9.1).
//
//   sync     → active devices whose PULL SCOPE covers the accepted op (tenant + store match, or a
//              tenant-wide op) AND that have no live realtime connection (the poke already covers
//              connected devices, api/04-push §6), coalesced to ≤ 1 per device per 60 s.
//   conflict → every active device of the conflict's store.
//   device   → active devices whose REGISTERED USER holds `auth.device_read` (owner devices); a
//              device with `user_id = null` gets none (10-db §8).
//
// Dispatch is POST-COMMIT, fire-and-forget (api/04-push §6): a sender that throws never fails the
// triggering request, and a push failure is logged, never surfaced as a sync error. The trigger
// functions below are what tasks 16/17 and the anomaly path call.
import type { ForTenant, TenantDb } from '@bolusi/db-server';

import { hasPermission } from '../auth/permissions.js';
import type { SurfacedConflict } from '../sync/conflict-detection.js';
import {
  composeConflict,
  composeDevice,
  composeSync,
  resolveLocale,
  type ComposedPush,
  type OutgoingPush,
} from './payload.js';
import type { PushPort } from './port.js';
import { invalidateFromTickets, scheduleReceiptPoll, type ReceiptScheduler } from './receipts.js';

/** api/02-auth §... permission a `device`-category recipient's user must hold (api/04-push §3). */
const DEVICE_READ = 'auth.device_read';

/** At most one `sync` push per device per this window (api/04-push §6). */
export const SYNC_COALESCE_MS = 60_000;

/**
 * Which devices currently hold a live WS/SSE connection (api/04-push §6). `sync` is NOT sent to a
 * connected device — the realtime poke already covers it. Default: NONE connected, until task 20's
 * realtime hub registers the real registry (this task's brief).
 */
export interface LiveConnectionRegistry {
  isConnected(deviceId: string): boolean;
}

export const NO_LIVE_CONNECTIONS: LiveConnectionRegistry = { isConnected: () => false };

/** Per-device `sync` coalescing (api/04-push §6): admit ≤ 1 send per device per `SYNC_COALESCE_MS`. */
export interface SyncCoalescer {
  /** True (and records the send) if this device may receive a `sync` push now; false within window. */
  admit(deviceId: string, nowMs: number): boolean;
}

export class InMemorySyncCoalescer implements SyncCoalescer {
  readonly #lastSentAt = new Map<string, number>();

  admit(deviceId: string, nowMs: number): boolean {
    const last = this.#lastSentAt.get(deviceId);
    if (last !== undefined && nowMs - last < SYNC_COALESCE_MS) return false;
    this.#lastSentAt.set(deviceId, nowMs);
    return true;
  }
}

export interface PushDeliveryLog {
  readonly kind: 'dispatch_failed';
  readonly category: string;
  readonly tenantId: string;
  readonly error: string;
}

/** Everything the trigger functions need — injected so tests bind `FakePushPort`, a fake registry,
 *  a controllable coalescer/scheduler, and a fake clock. */
export interface PushDeliveryDeps {
  readonly forTenant: ForTenant;
  readonly pushPort: PushPort;
  readonly liveConnections: LiveConnectionRegistry;
  readonly coalescer: SyncCoalescer;
  readonly receiptScheduler: ReceiptScheduler;
  readonly now: () => number;
  readonly logger?: (event: PushDeliveryLog) => void;
}

interface Recipient {
  readonly deviceId: string;
  readonly token: string;
  readonly locale: string | null;
}

/** Active devices with a registered token whose pull scope covers an op with `opStoreId`
 *  (api/01-sync §4.3): a tenant-wide op (`opStoreId = null`) reaches every device; a store op
 *  reaches only that store's devices. Store-less/system devices do NOT match a specific store. */
async function scopedRecipients(db: TenantDb, opStoreId: string | null): Promise<Recipient[]> {
  let q = db
    .selectFrom('pushTokens as pt')
    .innerJoin('devices as d', 'd.id', 'pt.deviceId')
    .leftJoin('userPrefs as up', 'up.userId', 'pt.userId')
    .select(['pt.deviceId as deviceId', 'pt.expoPushToken as token', 'up.locale as locale'])
    .where('d.status', '=', 'active');
  if (opStoreId !== null) q = q.where('d.storeId', '=', opStoreId);
  return q.execute();
}

/** Build outgoing messages from recipients + a per-recipient composer. */
function outgoing(
  recipients: readonly Recipient[],
  compose: (r: Recipient) => ComposedPush,
): OutgoingPush[] {
  return recipients.map((r) => ({ to: r.token, deviceId: r.deviceId, push: compose(r) }));
}

/**
 * Dispatch a set of messages post-commit, fire-and-forget (api/04-push §6). Sends, invalidates dead
 * tokens from tickets immediately, and schedules the delayed receipt poll. Any throw is caught and
 * logged — it NEVER propagates to the triggering request.
 */
async function dispatch(
  deps: PushDeliveryDeps,
  tenantId: string,
  category: string,
  messages: readonly OutgoingPush[],
): Promise<void> {
  if (messages.length === 0) return;
  try {
    const tickets = await deps.pushPort.send(messages);
    const pending = await invalidateFromTickets(deps.forTenant, tenantId, tickets);
    scheduleReceiptPoll(deps, tenantId, pending);
  } catch (err) {
    deps.logger?.({
      kind: 'dispatch_failed',
      category,
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * `sync` wake (api/04-push §3): an op (in store `opStoreId`, or tenant-wide when null) was accepted.
 * Targets in-scope devices with no live connection, coalesced per device. Data-only — no business
 * data, no title/body. Called by task 16's sync-accept path.
 */
export async function sendSyncWake(
  deps: PushDeliveryDeps,
  params: { tenantId: string; opStoreId: string | null },
): Promise<void> {
  try {
    const nowMs = deps.now();
    const recipients = await deps.forTenant(params.tenantId, (db) =>
      scopedRecipients(db, params.opStoreId),
    );
    const eligible = recipients.filter(
      (r) =>
        !deps.liveConnections.isConnected(r.deviceId) && deps.coalescer.admit(r.deviceId, nowMs),
    );
    await dispatch(
      deps,
      params.tenantId,
      'sync',
      outgoing(eligible, () => composeSync()),
    );
  } catch (err) {
    deps.logger?.({
      kind: 'dispatch_failed',
      category: 'sync',
      tenantId: params.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * `conflict` surfaced (api/04-push §3; 03-state-machines §7). Targets every active device of the
 * conflict's store (a tenant-wide conflict — `storeId = null` — reaches every device). Wired to
 * `deps.onConflictSurfaced` in composition; task 17 emits the surfacing.
 */
export async function sendConflictSurfaced(
  deps: PushDeliveryDeps,
  conflict: SurfacedConflict,
): Promise<void> {
  try {
    const recipients = await deps.forTenant(conflict.tenantId, (db) =>
      scopedRecipients(db, conflict.storeId),
    );
    const messages = outgoing(recipients, (r) =>
      composeConflict(conflict.conflictId, resolveLocale(localeRow(r))),
    );
    await dispatch(deps, conflict.tenantId, 'conflict', messages);
  } catch (err) {
    deps.logger?.({
      kind: 'dispatch_failed',
      category: 'conflict',
      tenantId: conflict.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * `device` alert (api/04-push §3): a device anomaly/revocation about `aboutDeviceId`. Targets active
 * devices whose registered user holds `auth.device_read` in that device's store scope — owner
 * devices; a `user_id = null` device gets none (10-db §8). The anomaly path calls this.
 */
export async function sendDeviceAlert(
  deps: PushDeliveryDeps,
  params: { tenantId: string; aboutDeviceId: string },
): Promise<void> {
  try {
    const messages = await deps.forTenant(params.tenantId, async (db) => {
      const candidates = await db
        .selectFrom('pushTokens as pt')
        .innerJoin('devices as d', 'd.id', 'pt.deviceId')
        .leftJoin('userPrefs as up', 'up.userId', 'pt.userId')
        .select([
          'pt.deviceId as deviceId',
          'pt.expoPushToken as token',
          'pt.userId as userId',
          'd.storeId as storeId',
          'up.locale as locale',
        ])
        .where('d.status', '=', 'active')
        .where('pt.userId', 'is not', null)
        .execute();

      const eligible: Recipient[] = [];
      for (const c of candidates) {
        if (c.userId === null) continue; // guarded by SQL, re-checked for the type narrowing
        const owner = await hasPermission(db, {
          userId: c.userId,
          tenantId: params.tenantId,
          storeId: c.storeId,
          permissionId: DEVICE_READ,
        });
        if (owner) eligible.push({ deviceId: c.deviceId, token: c.token, locale: c.locale });
      }
      return outgoing(eligible, (r) =>
        composeDevice(params.aboutDeviceId, resolveLocale(localeRow(r))),
      );
    });
    await dispatch(deps, params.tenantId, 'device', messages);
  } catch (err) {
    deps.logger?.({
      kind: 'dispatch_failed',
      category: 'device',
      tenantId: params.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** `resolveLocale` takes `{ locale } | undefined`; a null projection value means "no pref". */
function localeRow(r: Recipient): { locale: string } | undefined {
  return r.locale === null ? undefined : { locale: r.locale };
}
