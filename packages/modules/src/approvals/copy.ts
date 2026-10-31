// What every client says about a request, whatever draws it: how a module describes one, the tone
// of each status, and who asked or answered it.
import { ta, type ApprovalsKey } from './i18n.js';
import type { ApprovalRow } from './queries.js';

/** How the owning module says what a request is about. */
export interface ApprovalDescription {
  /** What it changes, e.g. the discount line's description. */
  readonly title: string;
  /** The amount as it reads there ("–Rp 25.000"), or null when it has none. */
  readonly amount: string | null;
  /** Anything else the approver should know first, one short sentence each. */
  readonly notes: readonly string[];
}

export type ApprovalTone = 'neutral' | 'success' | 'warning' | 'danger';

export const APPROVAL_STATUS_TONE: Readonly<Record<ApprovalRow['status'], ApprovalTone>> = {
  waiting: 'warning',
  approved: 'success',
  rejected: 'danger',
  withdrawn: 'neutral',
  closed: 'neutral',
};

export function approvalStatusLabel(status: ApprovalRow['status']): string {
  return ta(`approvals.status.${status}` as ApprovalsKey);
}

/** Who asked and why while it waits; who answered once it is answered. */
export function approvalByLine(row: ApprovalRow): string {
  if (row.status === 'waiting' || row.status === 'closed') {
    return ta('approvals.row.askedBy', { name: row.requestedByName ?? '–', reason: row.reason });
  }
  if (row.status === 'withdrawn') return ta('approvals.row.withdrawn');
  const answered = {
    status: approvalStatusLabel(row.status),
    name: row.decidedByName ?? '–',
  };
  // The approver's note goes back to whoever asked.
  return row.note === null
    ? ta('approvals.row.answeredBy', answered)
    : ta('approvals.row.answeredNote', { ...answered, note: row.note });
}

/**
 * The caller's limit when approving this request is beyond it (a manager), else null: the rules
 * would refuse it, so only rejecting is offered.
 */
export function approvalBeyondLimit(
  row: ApprovalRow,
  limitOf: (permissionId: string) => number | null,
): number | null {
  if (!row.canDecide || row.limitedBy === null) return null;
  const limit = limitOf(row.limitedBy);
  return limit !== null && row.counted > limit ? limit : null;
}

/** A row opens when there is something to do with it: answer it, or take it back. */
export function approvalActionable(row: ApprovalRow): boolean {
  return row.status === 'waiting' && (row.canDecide || row.mine);
}
