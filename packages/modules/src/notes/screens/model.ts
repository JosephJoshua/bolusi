// Pure view logic for the notes screens (04 §7 keeps screens thin; testable without a rendered tree,
// T-6). Everything here is a pure function of its inputs — no React, no clock, no i18n instance.
import type { OperationSyncStatus } from '@bolusi/ui';

import type { NoteSyncStatuses } from './runtime.js';

/** The op statuses backing one note (design-system §3.5); a note absent from the map is all-`synced`. */
export function statusesFor(map: NoteSyncStatuses, noteId: string): readonly OperationSyncStatus[] {
  return map[noteId] ?? [];
}

/**
 * Does this note have a rejected op? Drives NoteDetail's `danger` banner and the row's rejected chip
 * (design-system §3.6/§4.4 — a rejection is loud and never silent, 05-operation-log §8).
 */
export function hasRejectedOp(statuses: readonly OperationSyncStatus[]): boolean {
  return statuses.includes('rejected');
}

/**
 * A one-line body preview for a list row. Collapses whitespace so a multi-line body does not smuggle
 * newlines into a fixed-height row (§3.4). Empty ⇒ empty string, and the row shows the timestamp
 * alone rather than a blank secondary line.
 */
export function bodyPreview(body: string): string {
  return body.trim().replace(/\s+/g, ' ');
}
