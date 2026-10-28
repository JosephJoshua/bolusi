// The `approvals` module's phone pieces, used on the records requests are about, and its catalog,
// so op labels and refusals read in the person's language on every client.
export {
  APPROVALS_KEYS,
  approvalKindKey,
  registerApprovalsCatalog,
  ta,
  type ApprovalsKey,
} from '../i18n.js';
export type { ApprovalRow } from '../queries.js';
export type { ApprovalsPort } from '../runtime.js';
export type { ApprovalDescription } from '../copy.js';
export { ApprovalSection, ApprovalStatusChip, ApprovalStep } from './ApprovalViews.js';
