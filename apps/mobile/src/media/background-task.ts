// Trigger (d) — `expo-background-task` — 06-media-pipeline §5.2(d) / §5.4. The registration and the
// bounded pass are shared with the sync loop (bootstrap/background-task.ts, which also explains why a
// resolved `registerTaskAsync` proves nothing); this file is the media drain's use of them.
//
// ── WHAT §5.4 ASKS FOR AND WHAT THIS DELIVERS (stated, not glossed) ─────────────────────────────
// §5.4: "runs one bounded drain pass: **at most one media item or 60 s, whichever first**, then
// yields." The 60 s bound is REAL here — the pass races the loop's settle against a timer and
// yields when it expires. The ONE-ITEM bound IS NOT ENFORCED, and cannot be from this side:
// `MediaDrainLoop` (packages/core/src/media/drain.ts) exposes `requestDrain` / `settle` and no
// per-item bound, and task 82 may not edit the engine (task 18 owns it). A bounded pass that
// uploads two small items inside 60 s therefore overshoots the item bound while honouring the time
// bound. Recorded as a real gap rather than implied away: closing it is a small addition to core's
// loop (`requestDrain(reason, { maxItems })`) and belongs to whoever owns 06 next.
import type { MediaDrainTrigger, TimerPort } from '@bolusi/core';

import {
  registerBackgroundTask,
  runBoundedPass,
  type BackgroundRegistration,
  type BackgroundTaskPlatform,
} from '../bootstrap/background-task.js';

export {
  BACKGROUND_MINIMUM_INTERVAL_MINUTES,
  BACKGROUND_PASS_BUDGET_MS,
  BACKGROUND_STATUS_RESTRICTED,
  type BackgroundRegistration,
  type BackgroundTaskPlatform,
} from '../bootstrap/background-task.js';

/** The process-global task name. One string, one definition — a second would define a second task. */
export const MEDIA_DRAIN_TASK = 'bolusi.media.drain';

export interface BackgroundDrainDeps {
  readonly platform: BackgroundTaskPlatform;
  readonly requestDrain: (reason: MediaDrainTrigger) => void;
  /** Resolves when the drain cycle (and any coalesced re-run) settles — `MediaDrainLoop.settle`. */
  readonly settle: () => Promise<void>;
  readonly timer: TimerPort;
}

/**
 * One bounded background drain pass. Expiring is NOT a failure and nothing is rolled back: the drain
 * loop is chunk-resumable by construction (06 §5.1 — the server's `receivedChunks` is ground truth),
 * so a pass cut short at 60 s resumes exactly where it stopped on the next trigger.
 */
export function runBoundedDrainPass(deps: BackgroundDrainDeps): Promise<void> {
  return runBoundedPass({
    start: () => deps.requestDrain('background_task'),
    settle: deps.settle,
    timer: deps.timer,
  });
}

/** Define + register the media drain task, reporting whether it actually took. */
export function registerMediaDrainTask(deps: BackgroundDrainDeps): Promise<BackgroundRegistration> {
  return registerBackgroundTask(deps.platform, MEDIA_DRAIN_TASK, () => runBoundedDrainPass(deps));
}
