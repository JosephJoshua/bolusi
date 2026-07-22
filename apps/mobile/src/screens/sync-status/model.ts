/**
 * The Sync Status screen's view model (design-system §8.4/§4; 03-state-machines §8/§10;
 * 01-domain-model §5.2).
 *
 * ── THE DESIGN PROBLEM THIS FILE EXISTS TO SOLVE ────────────────────────────────────────────────
 * This screen is the app's honesty surface, and its whole job is a distinction most apps get wrong:
 *
 *     "offline — everything is saved here, this is fine"     vs     "something is actually wrong".
 *
 * In most apps those look identical: both render a red banner saying "no connection". On a device
 * that is offline BY DESIGN — a repair shop in West Papua, days between connections (D1/NFR-1001) —
 * that red banner is a lie. It alarms a cashier about the app's NORMAL operating mode, and because
 * it is always on, it trains the whole shop to ignore banners. Then the one that matters — your
 * changes were REJECTED and will never send — arrives in the same red, and nobody reads it. The
 * failure is not the red banner; it is that the red banner spent the shop's attention on nothing.
 *
 * So this model refuses to treat connectivity as health. `isOffline` is an input, never a problem.
 * The four things below are problems, and they have nothing to do with having a connection:
 *
 *   - `deviceRevoked`  — this device is blocked; nothing will EVER send again until re-enrollment.
 *   - `pushHalted`     — the local chain is broken (CHAIN_BROKEN, 05 §8); sending has STOPPED.
 *   - `rejected`       — the server refused these changes; they will never send (05 §8).
 *   - `quarantined`    — changes from another device failed verification and are being withheld.
 *
 * Each is permanent-until-a-human-acts, and each means data is not where the user thinks it is.
 * Being offline means none of those things: the work is on the device, it is safe, and it will send
 * itself. `sync.status.offline` says exactly that and says it neutrally — "Tidak ada koneksi.
 * Perubahan tersimpan di perangkat ini." (No connection. Changes are saved on this device.)
 *
 * Likewise a PENDING COUNT IS A RECEIPT, NOT A WARNING (design-system §4 rule 3: "Unsynced ≠
 * unsaved"). "3 perubahan belum terkirim" is the app telling you it is holding your work, not
 * confessing to losing it. It renders neutral, never danger, and never as a problem.
 *
 * The one honest escalation that survives all this is STALENESS (03 §8) — not "you are offline" but
 * "what is on this screen may be old". That is about the data's trustworthiness, which is the user's
 * actual question, and it escalates on a clock rather than on connectivity.
 */

import {
  stalenessLevel,
  type StalenessLevel,
  type SyncLoopState,
  type SyncState,
} from '@bolusi/core';
import type { BannerCause } from '@bolusi/ui';

/** 03-state-machines §Operation.syncStatus. */
export type OperationSyncStatus = 'local' | 'synced' | 'rejected';

/** 03-state-machines §MediaItem.uploadStatus (design-system §8.4 item 5). */
export type MediaUploadStatus = 'pending' | 'uploading' | 'uploaded' | 'failed';

/** A rejected op, as §8.4 item 4 renders it. `rejectionCode` keys `core.rejection.<CODE>`. */
export interface RejectedOpRow {
  readonly opId: string;
  readonly type: string;
  readonly at: number;
  /** 05 §8's closed set. Drives the label key — never rendered raw. */
  readonly rejectionCode: string;
  /** The server's technical detail — collapsed, never the primary message (ui-labels `sync.rejected.*`). */
  readonly rejectionReason: string | null;
}

/**
 * A media row as the QUERY returns it — any `uploadStatus`, including `uploaded`.
 *
 * The input carries `uploaded` and the output does not, and that asymmetry is deliberate: §8.4's
 * "`uploaded` rows drop off" is then a real transformation this model performs and a test can
 * witness. Typing the input as already-filtered would make `mediaQueue` dead code that no test could
 * exercise — a filter nobody can watch work is a filter nobody can trust.
 */
export interface MediaRow {
  readonly mediaId: string;
  readonly uploadStatus: MediaUploadStatus;
  /** 0–100 while `uploading`; null otherwise. */
  readonly progressPercent: number | null;
}

/** A row the queue actually renders (§8.4 item 5) — `uploaded` is gone by construction. */
export interface MediaQueueRow extends MediaRow {
  readonly uploadStatus: Exclude<MediaUploadStatus, 'uploaded'>;
}

/** A held-out pull-side batch (api/01-sync §4) — surfaced loud via `sync.quarantine.*`. */
export interface QuarantinedOpRow {
  readonly opId: string;
  readonly deviceId: string;
}

/**
 * Everything the screen renders from. `SyncState` and the derived counts arrive SEPARATELY and
 * deliberately (01 §5.2: the counts are derived queries, never stored).
 *
 * `SyncState` is `@bolusi/core`'s, since task 15 landed it and task 50 deleted the local stopgap
 * (`src/sync/contract.ts`) rather than keep a second definition (§2.8). The repoint was a rename,
 * not a rewrite, exactly as task 24 shaped it — with ONE structural difference worth stating:
 * `loopState` is NOT on the real `SyncState`, because 03 §10 says the loop's state is in-memory
 * ("one instance per app process"), never a persisted column. It therefore arrives here as its own
 * field, read from the live `SyncLoop.state`. That is the type system recording a real fact about
 * the system rather than a shape this screen preferred.
 */
export interface SyncStatusInput {
  readonly state: SyncState;
  /** The live loop's state (03 §10) — in-memory, never persisted, so never part of `SyncState`. */
  readonly loopState: SyncLoopState;
  readonly pendingOperationCount: number;
  readonly pendingMediaCount: number;
  readonly rejected: readonly RejectedOpRow[];
  readonly quarantined: readonly QuarantinedOpRow[];
  readonly media: readonly MediaRow[];
  /** Connectivity (NetInfo). An INPUT, never a verdict — see the header. */
  readonly isOffline: boolean;
  /** Is a manual sync in flight? Drives the button's `busy` (design-system §3.1). */
  readonly manualSyncBusy: boolean;
  /** The last manual-sync failure, shown INLINE (§8.4 item 3 — "never modal"). */
  readonly manualSyncError: string | null;
  readonly now: number;
}

/**
 * A thing that is actually WRONG. Being offline is not on this list, and never will be.
 * Every member is permanent until a human acts, and every member means data is not where the user
 * believes it is.
 */
export type SyncProblem =
  | { readonly kind: 'deviceRevoked' }
  | { readonly kind: 'pushHalted' }
  | { readonly kind: 'rejected'; readonly count: number }
  | { readonly kind: 'quarantined'; readonly count: number };

/**
 * The problems, worst first. An empty array is the load-bearing case: it means "nothing is wrong",
 * and the screen is then allowed to be calm no matter how offline or how backed-up the device is.
 */
export function syncProblems(input: SyncStatusInput): readonly SyncProblem[] {
  const problems: SyncProblem[] = [];
  // Revocation first: it subsumes everything else. Nothing will send again, ever, until re-enroll.
  if (input.state.syncDisabled && input.state.syncDisabledReason === 'device_revoked') {
    problems.push({ kind: 'deviceRevoked' });
  }
  // A broken chain has stopped the push permanently (05 §8 CHAIN_BROKEN → `pushHalted`).
  if (input.state.pushHalted) problems.push({ kind: 'pushHalted' });
  if (input.rejected.length > 0) problems.push({ kind: 'rejected', count: input.rejected.length });
  if (input.quarantined.length > 0) {
    problems.push({ kind: 'quarantined', count: input.quarantined.length });
  }
  return problems;
}

/**
 * THE distinction, as one boolean. True ⇒ the device is offline and nothing is wrong: say so
 * neutrally (`sync.status.offline`) and do not spend the user's attention.
 */
export function isOfflineButHealthy(input: SyncStatusInput): boolean {
  return input.isOffline && syncProblems(input).length === 0;
}

/**
 * The reassurance line — the answer to the only question the user actually has ("is my work safe?").
 *
 * It leads the screen because it is the answer, and because it is TRUE in every state except the
 * ones where it isn't: local writes are durable the moment they are made (design-system §4 rule 1),
 * so pending work is safe work. `attention` is reserved for the states where the app genuinely
 * cannot promise that a change will reach the server.
 */
export type Reassurance =
  | { readonly kind: 'allSent' }
  | { readonly kind: 'savedHere'; readonly pendingOperationCount: number }
  | { readonly kind: 'photosPending' }
  | { readonly kind: 'syncing' }
  | { readonly kind: 'attention'; readonly problems: readonly SyncProblem[] };

export function reassurance(input: SyncStatusInput): Reassurance {
  const problems = syncProblems(input);
  if (problems.length > 0) return { kind: 'attention', problems };
  if (input.loopState === 'pushing' || input.loopState === 'pulling') {
    return { kind: 'syncing' };
  }
  if (input.pendingOperationCount > 0) {
    return { kind: 'savedHere', pendingOperationCount: input.pendingOperationCount };
  }
  // Operations are all sent, but media drains on its OWN schedule (FR-1138, 06-media-pipeline §3):
  // the op loop never waits on media and vice versa, so "ops sent, photos still queued" is a
  // legitimate steady state — not a problem, and NOT "all sent". It is its own honest answer,
  // distinct from `savedHere` (which, keyed on the OP count, would render "0 changes not sent yet"
  // here) and from `allSent` (which would claim the photos were sent too). `syncTitleState` draws
  // the same distinction for the header title, so the answer and the title agree (task 147).
  if (input.pendingMediaCount > 0) return { kind: 'photosPending' };
  return { kind: 'allSent' };
}

/** The label key for each reassurance state. Keys only (07-i18n). */
export const REASSURANCE_KEY = {
  allSent: 'sync.status.upToDate',
  savedHere: 'sync.status.pending',
  photosPending: 'sync.status.photosPending',
  syncing: 'sync.status.syncing',
  attention: 'sync.rejected.banner',
} as const satisfies Record<Reassurance['kind'], string>;

/** The staleness tier the FreshnessCell and the banner both render (03 §8; design-system §3.11). */
export function staleness(input: SyncStatusInput): StalenessLevel {
  // core's `stalenessLevel` takes a `ClockPort`, not a number: `now` is an INPUT to this screen
  // (design-system renders from a snapshot), so it is adapted rather than read. No `?? Date.now()`
  // anywhere on this path — a default here would compute freshness from a clock the caller never
  // supplied, which is the one lie this screen exists to prevent (T-19).
  return stalenessLevel(input.state, { now: () => input.now });
}

/**
 * The §3.6 banner causes this screen contributes. Fed to `@bolusi/ui`'s `selectBanner`, which owns
 * the priority ladder — this function decides WHAT is true, never which one wins.
 *
 * NOTE FOR REVIEW — a real gap, not an omission: `BannerCause` (packages/ui) has no `quarantined`
 * member, so quarantined ops cannot raise a banner today. They ARE surfaced loud on this screen
 * (§8.4 / `sync.quarantine.*`), so nothing is silent, but the ambient escalation `api/01-sync §4`
 * implies is not reachable from a screen. `packages/ui` is CONTENDED this wave (CLAUDE.md §4), so
 * adding the cause is a coordinated design-system change, not an inline edit. Flagged for task 33.
 */
export function bannerCauses(input: SyncStatusInput): readonly BannerCause[] {
  const causes: BannerCause[] = [];
  for (const problem of syncProblems(input)) {
    if (problem.kind === 'deviceRevoked') causes.push({ kind: 'deviceRevoked' });
    if (problem.kind === 'rejected') causes.push({ kind: 'rejectedOps' });
  }
  // Staleness always contributes its level; `fresh` raises nothing (selectBanner drops it).
  causes.push({ kind: 'staleness', level: staleness(input) });
  return causes;
}

/** design-system §8.1's five header chip states. */
export type SyncChipState = 'synced' | 'pending' | 'syncing' | 'offline' | 'attention';

/**
 * The header chip, from the SAME inputs as the screen — so the chip and the screen can never
 * disagree about whether anything is wrong.
 *
 * PRECEDENCE, and why `offline` beats `pending`: a pending count while offline invites the exact
 * question the chip should already have answered ("why isn't it sending?"). `offline` answers it,
 * and answers it NEUTRALLY (§4 rule 6: "offline is a normal operating mode, not an error" — the
 * glyph is a grey cloud-off, never red). The count is one tap away on this screen, where there is
 * room to say "and your work is safe" alongside it.
 */
export function syncChipState(input: SyncStatusInput): SyncChipState {
  if (syncProblems(input).length > 0) return 'attention';
  if (input.loopState === 'pushing' || input.loopState === 'pulling') return 'syncing';
  if (input.isOffline) return 'offline';
  if (input.pendingOperationCount > 0) return 'pending';
  return 'synced';
}

/**
 * The header-title state. It is the five chip states PLUS one the chip cannot carry: `photosPending`
 * — operations all sent, photos still on their own drain schedule (FR-1138). See `syncTitleState`.
 */
export type SyncTitleState = SyncChipState | 'photosPending';

/**
 * The state the HEADER TITLE names — the same verdict as the chip, except for the one distinction the
 * five-state chip is not built to draw (design-system §8.1).
 *
 * ── WHY THIS IS NOT SIMPLY `syncChipState` (task 147) ───────────────────────────────────────────
 * The chip is media-blind BY SPEC: §8.1 gives it five states and defines `pending` as the count of
 * `local` ops only. That is correct for a tiny ambient pill about the OP loop. But task 126 keyed the
 * screen's LARGEST text on the chip, propagating that blind spot into the headline — so a device with
 * photos still queued (`pendingMediaCount > 0`, ops sent) read "Semua Terkirim" / "All Sent" above a
 * counter saying "3 foto belum terkirim". "All sent" while three photos are pending is a falsehood in
 * the *reassuring* direction, in the one text on the one screen a shop owner opens to trust it.
 *
 * The fix is NOT to fold media into the chip. Media drains independently of ops (FR-1138), so "ops
 * sent, photos uploading" is a legitimate steady state, never `attention`; and folding it into
 * `pending` or `synced` (the two mirror-image errors) would make a normal state look like a problem
 * or keep hiding it. Instead the TITLE — and only the title — gains its own honest state for exactly
 * that case. The chip stays `synced`: its verdict (the op loop is caught up) is still true, it has no
 * sixth state to spend, and media is surfaced where §8.4 puts it (the counter and the media queue).
 * So the chip and title still AGREE that nothing is wrong; the title merely says the one more true
 * thing the chip has no room for.
 */
export function syncTitleState(input: SyncStatusInput): SyncTitleState {
  const chip = syncChipState(input);
  if (chip === 'synced' && input.pendingMediaCount > 0) return 'photosPending';
  return chip;
}

/**
 * The screen's HEADER TITLE, one key per title state (design-system §8.1/§8.4; task 126, task 147).
 *
 * ── WHY THIS MAP EXISTS (task 126) ──────────────────────────────────────────────────────────────
 * The screen used to hardcode `sync.rejected.title` — "Perubahan Ditolak" / "Rejected Changes" —
 * for EVERY state. A fully-synced device was headed by a report of a problem it did not have, over
 * a body reading "Semua perubahan terkirim". On the one screen whose entire job is telling a shop
 * owner whether their work is safe, that is the failure this whole model exists to prevent
 * (see the header): spending the shop's attention on nothing until nobody reads the header at all.
 *
 * It is keyed on `syncTitleState` — the chip's verdict, plus the `photosPending` distinction the chip
 * cannot draw (task 147). The chip and the title never disagree about whether anything is WRONG (both
 * read `attention` together, `synced` together); the title only adds `photosPending`, which the chip
 * renders as `synced`. `offline` still gets its own title: offline is an input, never a problem (the
 * header's thesis), so it gets its own calm words instead of borrowing `pending`'s.
 *
 * `sync.rejected.title` stays what it always should have been: the header of the rejected SECTION,
 * rendered only when that section renders. `attention` titles the screen `sync.status.titleAttention`
 * instead, so the phrase appears once rather than three times.
 */
export const SYNC_TITLE_KEY = {
  synced: 'sync.status.titleSynced',
  pending: 'sync.status.titlePending',
  photosPending: 'sync.status.titlePhotosPending',
  syncing: 'sync.status.titleSyncing',
  offline: 'sync.status.titleOffline',
  attention: 'sync.status.titleAttention',
} as const satisfies Record<SyncTitleState, string>;

/**
 * §8.4 item 3: manual sync is disabled, WITH an explanation, when the loop cannot run at all.
 * A disabled button with no reason is how a user concludes the app is broken; `reason` is the key
 * the screen renders beside it.
 */
export type ManualSync =
  | { readonly kind: 'ready' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'disabled'; readonly reasonKey: string };

export function manualSync(input: SyncStatusInput): ManualSync {
  if (input.state.syncDisabled && input.state.syncDisabledReason === 'device_revoked') {
    return { kind: 'disabled', reasonKey: 'core.rejection.DEVICE_REVOKED' };
  }
  if (input.manualSyncBusy) return { kind: 'busy' };
  // Deliberately ENABLED while offline: pressing it is how a user finds out whether the connection
  // is back, and the loop is what decides. Greying it out because NetInfo says offline would make
  // the app's opinion of the network override the user's — and NetInfo is often wrong on a phone
  // hopping between a flaky shop hotspot and cellular.
  return { kind: 'ready' };
}

/** §8.4 item 4: the rejected section renders only when non-empty. */
export function showsRejectedSection(input: SyncStatusInput): boolean {
  return input.rejected.length > 0;
}

/** §8.4 item 5: the media queue renders only when non-empty; `uploaded` rows drop off. */
export function mediaQueue(input: SyncStatusInput): readonly MediaQueueRow[] {
  return input.media.filter((row): row is MediaQueueRow => row.uploadStatus !== 'uploaded');
}

// NOTE: there is deliberately NO `rejectionKey()` helper here. `@bolusi/i18n`'s
// `translateRejectionCode(code)` already owns the `core.rejection.<CODE>` derivation AND the
// unknown-code fallback + warn-once (07-i18n §4.2/§4.3), so the screen calls that. A local helper
// that rebuilt the same key would be a second answer to one question (CLAUDE.md §2.8) — and the
// copy without the fallback would render a raw missing key to a cashier the first time 05 §8 gained
// a code. `rejection-keys.test.ts` proves every code in the closed set resolves in BOTH catalogs.

/** The label key for a media row's status chip. */
export const MEDIA_STATUS_KEY = {
  pending: 'media.status.pending',
  uploading: 'media.status.uploading',
  failed: 'media.status.failed',
} as const satisfies Record<MediaQueueRow['uploadStatus'], string>;
