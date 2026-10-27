// Clock-skew flagging (05 §6). Flags, never rejects: a past timestamp is the device's honest
// belief and business truth ("when the employee acted"), preserved through late sync; the server
// assumes drift, not malice (PRD-009 §6). The one timestamp the pipeline refuses is one too far in
// the FUTURE (core sync/clock-guard.ts), because it would win last-writer-wins; that check is not
// here.

/** 48h base window (05 §6). */
export const SKEW_BASE_MS = 48 * 60 * 60 * 1000;

/**
 * True iff `|timestamp − receivedAt|` is grossly inconsistent with the device's offline window:
 *   threshold = 48h + max(0, receivedAt − lastSyncAt).
 *
 * A device offline for days legitimately carries older timestamps, so the window grows with the
 * offline gap. `lastSyncAt === null` (never synced) → offline window 0 → threshold = 48h. The
 * comparison is strict `>`, so an op exactly at the window boundary is NOT flagged.
 */
export function isClockSkewed(
  timestamp: number,
  receivedAt: number,
  lastSyncAt: number | null,
): boolean {
  const offlineWindow = Math.max(0, receivedAt - (lastSyncAt ?? receivedAt));
  const threshold = SKEW_BASE_MS + offlineWindow;
  return Math.abs(timestamp - receivedAt) > threshold;
}
