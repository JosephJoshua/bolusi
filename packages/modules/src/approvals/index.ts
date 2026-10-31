// The `approvals` module's platform-free surface.
export * from './constants.js';
export {
  approvalKind,
  type ApprovalKind,
  type ApprovalKinds,
  type ApprovalTarget,
} from './kinds.js';
export { createApprovalsModule, type ApprovalsModule } from './manifest.js';
export type { ApprovalRow } from './queries.js';
export { APPROVAL_REFUSALS } from './rules.js';
export type { ApprovalsDatabase, ApprovalRequestsTable } from './schema.js';
export type { ApprovalsPort } from './runtime.js';
export {
  APPROVALS_KEYS,
  approvalKindKey,
  registerApprovalsCatalog,
  ta,
  type ApprovalsKey,
} from './i18n.js';
