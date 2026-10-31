// Identifiers for the `approvals` module: asking an owner (or someone whose limit covers it) to
// make a decision the asker may not make themselves (product-scope.md, "Managers, limits,
// approvals and roles"). A request names a command of another module and its input; approving it
// runs that command as the approver, so the decision is theirs and judged by its usual rules.
//
// Op types are past tense and permission ids present tense, as in every other module.

export const APPROVALS_MODULE_ID = 'approvals' as const;

export const APPROVAL_ENTITY = 'approval_request' as const;

export const APPROVALS_TABLE = 'approval_requests' as const;

export const APPROVAL_OP = {
  /** Someone asks for a decision, with a reason. */
  requested: 'approvals.request_made',
  /** The approver says yes; the decision itself is recorded with it, as the approver's. */
  approved: 'approvals.request_approved',
  rejected: 'approvals.request_rejected',
  /** The asker takes it back while it waits. */
  withdrawn: 'approvals.request_withdrawn',
} as const;

export const APPROVAL_PERMISSION = {
  /**
   * Ask for approval and answer requests. Every role holds it: what someone may ask for, and
   * decide, is the permission of the decision itself (each kind says which).
   */
  use: 'approvals.use',
} as const;

export const APPROVAL_STATUSES = ['waiting', 'approved', 'rejected', 'withdrawn'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const MAX_APPROVAL_REASON = 500;
export const MAX_APPROVAL_NOTE = 500;
