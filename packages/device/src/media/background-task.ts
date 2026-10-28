// Trigger (d) — `expo-background-task` — 06-media-pipeline §5.2(d) / §5.4. The host, registration and
// bounded pass are shared with the sync loop (bootstrap/background-task.ts, which also explains why
// a resolved `registerTaskAsync` proves nothing); this file is the media drain's use of them.
//
// ── WHAT §5.4 ASKS FOR AND WHAT THIS DELIVERS (stated, not glossed) ─────────────────────────────
// §5.4: "runs one bounded drain pass: **at most one media item or 60 s, whichever first**, then
// yields." The 60 s bound is REAL here — the pass races the loop's settle against a timer and
// yields when it expires. The ONE-ITEM bound IS NOT ENFORCED, and cannot be from this side:
// `MediaDrainLoop` (packages/core/src/media/drain.ts) exposes `requestDrain` / `settle` and no
// per-item bound. A bounded pass that uploads two small items inside 60 s therefore overshoots the
// item bound while honouring the time bound, which is harmless: the bound exists to stay inside the
// OS's background allowance, and the time bound is what does that.
import {
  registerHostTask,
  type BackgroundBinding,
  type BackgroundRegistration,
} from '../bootstrap/background-task.js';

/** The process-global task name. Defined once, at module scope in index.ts. */
export const MEDIA_DRAIN_TASK = 'bolusi.media.drain';

export function registerMediaDrainTask(
  binding: BackgroundBinding,
): Promise<BackgroundRegistration> {
  return registerHostTask(binding, MEDIA_DRAIN_TASK);
}
