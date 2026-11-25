// Erasing a blocked device. When an owner blocks a phone or PC (lost, stolen, a dismissed employee's
// own phone), the server answers its next request with 401 DEVICE_REVOKED and the sync loop records
// that (core sync/loop.ts). Blocking alone only stops sync: the customers, servisan and cash already
// on the device would stay readable. So the next foreground start confirms the block with the server
// and then erases everything the app keeps on the device, before any screen is shown.
//
// Confirm first: one stray 401 must never erase a device. The start asks `GET /v1/devices/me`, which
// answers DEVICE_REVOKED only for a blocked registration; a normal answer means the record was wrong
// and sync resumes; no answer (offline) leaves the device locked on the "blocked" setup screen until
// a start that can ask.
//
// Unsent changes on the device are erased with the rest. The owner is told when the device last
// synced before blocking it; there is no way to recover them and the device must not keep them.
import {
  DEVICE_REVOKED_ERROR_CODE,
  DEVICE_REVOKED_REASON,
  readMeta,
  readSyncState,
  writeMeta,
  writeSyncState,
  type ClockPort,
  type SyncState,
} from '@bolusi/core';
import type { Kysely } from 'kysely';

import type { Bootstrapped } from './bootstrap.js';
import { toTransportError, withDeadline } from './transport.js';

/** `meta_kv` key set on the fresh database after an erase, so setup says why the device is empty. */
export const BLOCKED_WIPE_META_KEY = 'auth.wipedAfterBlock';

/** What the server says about this device's registration. */
export type BlockCheck = 'blocked' | 'not_blocked' | 'unknown';

/** True when the sync loop recorded that the server blocked this device. */
export function isBlockedSyncState(state: SyncState): boolean {
  return state.syncDisabled && state.syncDisabledReason === DEVICE_REVOKED_REASON;
}

/** Whether a fresh (unregistered) database was left by erasing a blocked device. */
export async function readWipedAfterBlock<DB>(db: Kysely<DB>): Promise<boolean> {
  return (await readMeta(db, BLOCKED_WIPE_META_KEY)) !== null;
}

export interface BlockProbeConfig {
  /** Server base URL, no trailing slash. */
  readonly baseUrl: string;
  /** The device token, read at call time. */
  readonly deviceToken: () => Promise<string | null>;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const PROBE_TIMEOUT_MS = 15_000;

/**
 * Ask the server whether this registration is blocked. Only an answer counts: a network failure,
 * a timeout, a server error or a body that is not the server's envelope is `unknown`.
 *
 * A missing token on a device the loop recorded as blocked is `blocked`: only an erase removes the
 * token, so its absence means an earlier erase stopped part way, and the rest must still go.
 */
export function createBlockProbe(config: BlockProbeConfig): () => Promise<BlockCheck> {
  const doFetch = config.fetchImpl ?? fetch;
  return async () => {
    const token = await config.deviceToken();
    if (token === null || token === '') return 'blocked';
    try {
      return await withDeadline(config.timeoutMs ?? PROBE_TIMEOUT_MS, async (signal) => {
        const response = await doFetch(`${config.baseUrl}/v1/devices/me`, {
          headers: { Authorization: `Bearer ${token}` },
          signal,
        });
        if (response.ok) return 'not_blocked';
        const error = await toTransportError(response);
        return error.code === DEVICE_REVOKED_ERROR_CODE ? 'blocked' : 'unknown';
      });
    } catch {
      return 'unknown';
    }
  };
}

export interface BlockedWipeDeps {
  /** The data-layer boot. Called again after the erase, to open the fresh empty database. */
  readonly boot: () => Promise<Bootstrapped>;
  /** Forget a cached boot, so the call after the erase opens a new database (phone: one per realm). */
  readonly forgetBoot?: () => void;
  readonly probe: () => Promise<BlockCheck>;
  /**
   * Erase everything the app keeps on this device, the database closed: photos and videos first,
   * then the database key and files, then the device's own keys and token. The database goes after
   * the media because it holds the "blocked" record, so a start interrupted part way erases again.
   */
  readonly eraseDevice: () => Promise<void>;
  readonly clock: ClockPort;
}

/**
 * Boot, and if the device was blocked, confirm it with the server and erase it. Returns the app to
 * show: the same one when nothing was blocked or the server could not be asked, otherwise a fresh
 * unregistered one whose setup screen says the device was blocked.
 */
export async function bootErasingBlocked(deps: BlockedWipeDeps): Promise<Bootstrapped> {
  const app = await deps.boot();
  if (!isBlockedSyncState(app.syncState)) return app;

  const check = await deps.probe().catch((): BlockCheck => 'unknown');
  if (check === 'unknown') return app;
  if (check === 'not_blocked') {
    // The record was wrong (a stray answer): sync resumes.
    await writeSyncState(app.db.db as never, {
      syncDisabled: false,
      syncDisabledReason: null,
      lastSyncError: null,
    });
    return { ...app, syncState: await readSyncState(app.db.db as never) };
  }

  await app.close();
  await deps.eraseDevice();
  deps.forgetBoot?.();
  const fresh = await deps.boot();
  await writeMeta(fresh.db.db as never, BLOCKED_WIPE_META_KEY, String(deps.clock.now()));
  return { ...fresh, wipedAfterBlock: true };
}
