// The dialect-neutral shape the `approvals` appliers and queries are typed against, as money does.
// Times are ms epoch integers; money is integer IDR. Column order is the DDL order in both
// migrations and the manifest.

/** One request: what was asked, by whom, and how it was answered. */
export interface ApprovalRequestsTable {
  id: string;
  tenantId: string;
  storeId: string;
  /** `ApprovalKind.id`, e.g. `repair.discount`. */
  kind: string;
  /** What it is about (a servisan), so the record's own page shows its requests. */
  targetType: string;
  targetId: string;
  /** The command input approval runs, as JSON. */
  inputJson: string;
  /** What the decision is worth in rupiah, as asked. */
  amount: number;
  reason: string;
  /** What the request depends on (`ApprovalKind.basis`) when it was asked. */
  basis: string;
  requestedBy: string;
  requestedAt: number;
  /** `ApprovalStatus`. */
  status: string;
  decidedBy: string | null;
  decidedAt: number | null;
  /** The approver's note, or null. */
  note: string | null;
}

export interface ApprovalsDatabase {
  approvalRequests: ApprovalRequestsTable;
}
