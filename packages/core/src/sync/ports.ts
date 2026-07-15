// The sync loop's injected seams (08-stack-and-repo §3.2; testing-guide T-6).
//
// @bolusi/core is PLATFORM-FREE (08 §3.3 rule 3): no `fetch`, no `setTimeout`, no `Date.now()`.
// The loop is the surface where that bites hardest — it is *made* of network and time — so every
// one of those effects arrives here as an interface. That is what lets the whole of api/01-sync §6
// run under a FakeClock with a fake transport and zero sockets (the acceptance bar for task 15),
// and it is what CHAOS-02's fault injection plugs into: `FaultFetch` is a `SyncTransportPort`.
//
// 08 §4.3 is explicit that the sync engine does NOT know Hono: it speaks `@bolusi/schemas` DTOs,
// and the hc-typed client lives in the thin adapter (apps/mobile, harness). So these signatures
// name wire DTOs and nothing else — no Response, no status codes, no headers.
import type { PullRequest, PullResponse, PushRequest, PushResponse } from '@bolusi/schemas';

/**
 * A transport failure, thrown by `SyncTransportPort` adapters.
 *
 * WHY `code` AND NOT `status`. api/01-sync §2's revoked-device signal is a `401`, but so are
 * `AUTH_TOKEN_MISSING` and `AUTH_TOKEN_INVALID` (apps/server errors.ts maps all three to 401).
 * Discriminating on the status would disable sync permanently — `syncDisabled` has no automatic
 * exit (03 §10) — on a merely-expired token. So the loop discriminates on the api/00 §7 error
 * envelope's `error.code`, and the adapter's job is to carry it here verbatim.
 *
 * `code` is `string | null`, not the `RejectionCode` enum: api/00 §4 says store and surface
 * unknown codes rather than drop them, and a server that grows a code must not make the client
 * throw on the way to reporting it.
 */
export class SyncTransportError extends Error {
  override readonly name = 'SyncTransportError';
  /** The api/00 §7 error envelope's `error.code`, or `null` for a pre-response failure. */
  readonly code: string | null;
  /** HTTP status when a response was received; `null` for network errors/timeouts. */
  readonly status: number | null;

  constructor(message: string, options?: { code?: string | null; status?: number | null }) {
    super(message);
    this.code = options?.code ?? null;
    this.status = options?.status ?? null;
  }
}

/** api/00 §7 `error.code` for a revoked device — the one code with a terminal client reaction. */
export const DEVICE_REVOKED_ERROR_CODE = 'DEVICE_REVOKED';

/**
 * The sync wire (api/01-sync §3–§4), typed by schemas DTOs only.
 *
 * Both methods reject with `SyncTransportError` on any transport/server failure. A rejection is a
 * LOOP failure (→ backoff, 03 §10); an op-level `rejected` inside a resolved `PushResponse` is
 * NOT (03 §10: "an op-level rejected result is not a loop failure"). That distinction is the
 * whole reason push results are a return value and failures are rejections.
 */
export interface SyncTransportPort {
  /** `POST /v1/sync/push` (api/01-sync §3). */
  push(request: PushRequest): Promise<PushResponse>;
  /** `POST /v1/sync/pull` (api/01-sync §4). */
  pull(request: PullRequest): Promise<PullResponse>;
}

/** Outcome of the once-per-loop bundle refresh. `unchanged` is the `304` steady state. */
export type BundleRefreshOutcome = 'refreshed' | 'unchanged';

/**
 * The conditional `GET /v1/devices/me/bundle` step (api/01-sync §6 line 3; api/02-auth §5).
 *
 * DELIBERATELY A HOOK, NOT A BUNDLE TRANSPORT. Task 14 owns bundle fetching, ETag handling and
 * `applyBundle`; re-declaring any of that here would be a second definition of one seam
 * (CLAUDE.md §2.8). The loop needs exactly two facts — "run it once per cycle" and "did it fail"
 * — so that is all this interface carries. `304` is a SUCCESS: the adapter resolves `'unchanged'`
 * rather than throwing, because a steady-state device gets a 304 on every single cycle and a loop
 * that treated it as failure would live in permanent backoff.
 */
export interface BundleRefreshPort {
  refresh(): Promise<BundleRefreshOutcome>;
}

/** Cancels a scheduled callback. Calling it after the callback fired is a no-op. */
export type CancelTimer = () => void;

/**
 * The backoff timer (03 §10). Injected because core owns no timers (08 §3.3 rule 3) and because
 * a real `setTimeout` would make the backoff schedule untestable without sleeping — testing-guide
 * T-6: a test that sleeps is a bug.
 */
export interface TimerPort {
  schedule(delayMs: number, fn: () => void): CancelTimer;
}

/**
 * Everything the loop surfaces to the user (05 §8's "never silent"; api/01-sync §4.2's "surface
 * loudly"). Label KEYS, never copy — core cannot import @bolusi/i18n (08 §3.3) and T-4 asserts
 * keys anyway, so copy in core would be both a boundary break and an untestable string.
 */
export type SyncSurfacing =
  | {
      /** An op the server refused (05 §8). Emitted for EVERY code — the closed set has no silent member. */
      readonly kind: 'op_rejected';
      readonly opId: string;
      /** The 05 §8 code, verbatim from the wire (may be unknown to this client — api/00 §4). */
      readonly code: string;
      readonly reason: string;
      /** `core.rejection.<CODE>` (ui-labels §"one row per code in 05 §8's closed set"). */
      readonly labelKey: string;
    }
  | {
      /** Push halted by `CHAIN_BROKEN` (03 §10). Surfaced loudly — requires investigation (05 §8). */
      readonly kind: 'push_halted';
      readonly opId: string;
      readonly labelKey: string;
    }
  | {
      /** A pulled op failed verification and was quarantined (api/01-sync §4.2). */
      readonly kind: 'quarantined';
      readonly opId: string;
      readonly reason: QuarantineReason;
      readonly labelKey: string;
    }
  | {
      /** The device was revoked; all sync stops (03 §10). */
      readonly kind: 'sync_disabled';
      readonly reason: string;
      readonly labelKey: string;
    };

/** Why an op sits in `quarantined_ops` (10-db §9.5 CHECK — a third value is a migration). */
export type QuarantineReason = 'bad_signature' | 'unknown_pubkey';

/**
 * The surfacing sink. Fire-and-forget and SYNCHRONOUS by contract: the loop never awaits the UI,
 * and — api/01-sync §6 — "never throws to UI". A sink that throws would turn a surfaced rejection
 * into a loop failure, i.e. the act of reporting a problem would create one, so the loop guards
 * every call (see `loop.ts`).
 */
export interface SyncSurfacePort {
  emit(event: SyncSurfacing): void;
}
