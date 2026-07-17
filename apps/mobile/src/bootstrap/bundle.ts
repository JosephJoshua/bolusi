// The `BundleRefreshPort` producer — the FETCH half of the device bundle (api/02-auth §5.2), in the
// thin adapter layer. Task 14 shipped `applyBundle` (the APPLY half); this is what task 15's loop
// calls once per cycle (loop.ts → `this.options.bundle.refresh()`), and without it the loop is not
// constructible (task 89).
//
// ── 304 IS A SUCCESS, AND THAT IS THE WHOLE POINT (api/02-auth §5.2; ports.ts docblock) ─────────
// A steady-state device gets a `304 Not Modified` on EVERY cycle (the conditional `If-None-Match`).
// This resolves `'unchanged'` on 304 and `'refreshed'` on 200 — it does NOT throw on 304. A producer
// that treated 304 as a failure would put a perfectly healthy device into permanent backoff (03 §10),
// which is the exact bug ports.ts warns about and the acceptance test falsifies.
//
// ── WHY THE `error.code`, NOT THE STATUS (shared with transport.ts) ─────────────────────────────
// A genuine failure (5xx, a 401 that is NOT a 304) becomes a `SyncTransportError` carrying the api/00
// §7 envelope's `error.code` verbatim, via the SAME `toTransportError` the sync transport uses (§2.8:
// one envelope parser, not two). So a `401 DEVICE_REVOKED` from the bundle endpoint disables sync,
// while a `401 AUTH_TOKEN_INVALID` merely backs off — the loop discriminates on the code, and this is
// where "verbatim" is done for the bundle path too.
//
// ── APPLY + ETAG ARE ONE ATOM ───────────────────────────────────────────────────────────────────
// On 200, the bundle is applied and the new ETag stored in ONE transaction. If they came apart, a
// crash could advance the stored ETag without applying the bundle — then every future `304` would
// confirm a bundle this device never actually persisted. `applyBundle` is idempotent (bundle-apply.ts),
// so re-applying after a rolled-back write is safe; storing an ETag for an unapplied bundle is not.
import {
  applyBundle,
  readMeta,
  writeMeta,
  SyncTransportError,
  type BundleRefreshOutcome,
  type BundleRefreshPort,
  type DeviceBundle,
} from '@bolusi/core';
import type { ClientDb } from '@bolusi/db-client';

import { toTransportError } from './transport.js';

/**
 * `meta_kv` key holding the last bundle ETag (api/02-auth §5.2 — SHA-256 of the RFC 8785
 * canonicalization). `meta_kv` is 10-db §9's "misc scalars" store; a scalar key is not a schema
 * change. Null until the first successful refresh: the first `GET` then omits `If-None-Match` and
 * takes a full `200` (re-applying the same directory the enroll bundle already wrote — idempotent),
 * after which every steady-state cycle is a `304`.
 */
export const BUNDLE_ETAG_META_KEY = 'bundleEtag';

/** The `200` body of `GET /v1/devices/me/bundle` (api/02-auth §5.2). LOCAL STOPGAP shape — task 33. */
interface BundleResponseBody {
  readonly bundle: DeviceBundle;
  readonly etag: string;
  readonly serverTime: number;
}

export interface BundleRefreshConfig {
  /** Base URL of the server, no trailing slash (08 §6.1's `EXPO_PUBLIC_API_URL`). */
  readonly baseUrl: string;
  /** The `bdt_`-prefixed device token (api/02-auth §3/§8), read at call time — never cached here. */
  readonly deviceToken: () => Promise<string | null>;
  /** The one client connection (08 §2.2). Its `db` reads/writes `meta_kv`; its `transaction` makes
   *  the apply+ETag one atom on the SAME connection the directory tables live on. */
  readonly db: ClientDb;
  /**
   * Invoked AFTER a `'refreshed'` commit so a caller holding the permission memo can invalidate it
   * (02-permissions §6: "a bundle refresh wrote a directory table"). Wired since task 92: the
   * composition root builds ONE `PermissionEvaluator` (bootstrap/runtime.ts) and passes its
   * `onBundleRefresh` through `createSyncClientForApp`. Still OPTIONAL — a Node test or a device with
   * no runtime composed leaves it undefined — and a CLEAN injected seam, never a resolving no-op.
   */
  readonly onBundleRefreshed?: () => void | Promise<void>;
  /** Injected for tests; defaults to the global. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Build the `BundleRefreshPort`. `refresh()` is the once-per-cycle conditional GET (api/01-sync §6).
 */
export function createFetchBundleRefresh(config: BundleRefreshConfig): BundleRefreshPort {
  const doFetch = config.fetchImpl ?? fetch;

  return {
    async refresh(): Promise<BundleRefreshOutcome> {
      const token = await config.deviceToken();
      if (token === null) {
        // Fail closed, exactly as the sync transport does: no anonymous bundle GET. `AUTH_TOKEN_MISSING`
        // (not `DEVICE_REVOKED`) so the loop backs off rather than disabling on a merely-absent token.
        throw new SyncTransportError('no device token available', {
          code: 'AUTH_TOKEN_MISSING',
          status: null,
        });
      }

      const etag = await readMeta(config.db.db, BUNDLE_ETAG_META_KEY);
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (etag !== null) headers['If-None-Match'] = etag;

      const response = await doFetch(`${config.baseUrl}/v1/devices/me/bundle`, {
        method: 'GET',
        headers,
      });

      // 304 is the steady state — a SUCCESS. Return WITHOUT touching the directory or the ETag.
      if (response.status === 304) return 'unchanged';
      if (!response.ok) throw await toTransportError(response);

      const body = (await response.json()) as BundleResponseBody;
      await config.db.transaction(async () => {
        await applyBundle(config.db.db, body.bundle);
        await writeMeta(config.db.db, BUNDLE_ETAG_META_KEY, body.etag);
      });
      await config.onBundleRefreshed?.();
      return 'refreshed';
    },
  };
}
