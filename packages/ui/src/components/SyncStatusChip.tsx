/**
 * SyncStatusChip (design-system §3.5) — the canonical pending-marker of the whole app.
 *
 * Screens hand over the raw `Operation.syncStatus` values of the entity's ops (03-state-machines
 * §2/§3: `local | synced | rejected`) and this component decides what shows. That direction is
 * deliberate: §3.5 ends with "screens never compute their own sync heuristics". If every list row
 * re-derived "is this pending?", the app would drift into as many answers as there are screens.
 */
import { useMemo } from 'react';

import type { SyncStatus } from '@bolusi/schemas';

import { Chip } from './Chip.js';

/**
 * `Operation.syncStatus` (03-state-machines §2 enum registry — client-local bookkeeping):
 * `local | synced | rejected`. Imported TYPE-ONLY from its canonical owner (`@bolusi/schemas`,
 * `SyncStatus`) under the 08 §3.3 `uiSchemasTypeOnly` boundary exception. `verbatimModuleSyntax`
 * elides an `import type` from the emit entirely, so ui pulls no zod and stays platform-free (the
 * boundary's real intent) while the enum can no longer drift from its owner — a value import of
 * `@bolusi/schemas` from ui stays a lint/hygiene error. Re-exported under the design-system name the
 * screens already use.
 */
export type OperationSyncStatus = SyncStatus;

/**
 * Runtime membership for the throw-on-unknown guard in `resolveSyncChip`. Keyed EXHAUSTIVELY by the
 * imported type: add or drop a status in `@bolusi/schemas` and this literal stops compiling until it
 * matches (missing AND extra keys both caught), so the guard cannot silently diverge from the enum.
 * That compile-time exhaustiveness is what let this task retire the cross-package parity gate's ui
 * arm (task 53 → task 190) — carrying the type across the boundary makes the runtime mirror gate
 * redundant.
 */
const VALID_STATUS: Record<OperationSyncStatus, true> = {
  local: true,
  synced: true,
  rejected: true,
};
const VALID: ReadonlySet<string> = new Set(Object.keys(VALID_STATUS));

/** What the §3.5 table resolves to; `null` = synced is the silent default (a checkmark on everything is noise). */
export type SyncChipKind = 'pending' | 'rejected' | null;

export interface SyncStatusChipProps {
  /** The syncStatus of every op backing this entity. Empty ⇒ nothing to say. */
  readonly syncStatuses: readonly OperationSyncStatus[];
  /** Already-localized `sync.chip.pending`. */
  readonly pendingLabel: string;
  /** Already-localized `sync.chip.rejected`. */
  readonly rejectedLabel: string;
  /** §3.5: the rejected chip is ALWAYS tappable → rejected-op detail on Sync Status (§8.4). */
  readonly onPressRejected: () => void;
  readonly testID?: string | undefined;
}

/**
 * §3.5 precedence: `rejected` wins over `local`; all-`synced` shows nothing.
 *
 * Throws on an unrecognised value rather than falling through to "no chip". A silent wrong answer
 * here would mean a rejected op renders as calm-or-absent, and 05-operation-log §8 / §4.4 are
 * explicit that rejection is never silent. The enum is closed and DB-backed, so an unknown value is
 * a bug in the caller, and a loud one is cheaper to find than a missing chip nobody noticed.
 */
export function resolveSyncChip(statuses: readonly OperationSyncStatus[]): SyncChipKind {
  for (const status of statuses) {
    if (!VALID.has(status)) {
      throw new Error(
        `Unknown Operation.syncStatus ${JSON.stringify(status)}: expected one of local|synced|rejected (03-state-machines §2).`,
      );
    }
  }
  if (statuses.includes('rejected')) return 'rejected';
  if (statuses.includes('local')) return 'pending';
  return null;
}

export function SyncStatusChip({
  syncStatuses,
  pendingLabel,
  rejectedLabel,
  onPressRejected,
  testID = 'ui.syncStatusChip',
}: SyncStatusChipProps): React.JSX.Element | null {
  const kind = useMemo(() => resolveSyncChip(syncStatuses), [syncStatuses]);

  if (kind === null) return null;

  if (kind === 'rejected') {
    return (
      <Chip
        testID={`${testID}.rejected`}
        label={rejectedLabel}
        icon="rejected"
        tone="danger"
        onPress={onPressRejected}
      />
    );
  }

  // Pending is INFORMATIONAL, not alarming (§3.5, §4.3): the action already succeeded locally.
  // Neutral tone + clock icon, and no `onPress` — there is nothing for the user to fix.
  return <Chip testID={`${testID}.pending`} label={pendingLabel} icon="pending" tone="neutral" />;
}
