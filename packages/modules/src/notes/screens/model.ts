// Pure view logic for the notes screens (04 §7 keeps screens thin; testable without a rendered tree,
// T-6). Everything here is a pure function of its inputs — no React, no clock, no i18n instance.
// The sync-status helpers are shared by every module's screens; re-exported for existing callers.
export { rejectedCount, statusesFor } from '../../screen-kit/index.js';

/**
 * A one-line body preview for a list row. Collapses whitespace so a multi-line body does not smuggle
 * newlines into a fixed-height row (§3.4). Empty ⇒ empty string, and the row shows the timestamp
 * alone rather than a blank secondary line.
 */
export function bodyPreview(body: string): string {
  return body.trim().replace(/\s+/g, ' ');
}
