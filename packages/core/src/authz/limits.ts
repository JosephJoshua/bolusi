// Limits on the owners' money decisions (product-scope.md, "Managers, limits, approvals and roles").
//
// Some permissions let someone lower what a customer owes or let money leave the store: a discount,
// a refund, a phone handed over unpaid. A role is either free of limits (the owners) or LIMITED: then
// each store sets how far that role may go there, one amount per kind, per servisan. A limited role
// with no amount set may go nowhere (Rp 0): a missing limit never means "any amount".
//
// A permission says which kind of limit applies to it (`PermissionDeclaration.limit`); the role's
// amounts live with the directory (`DirectoryRole.limits`). The decision is made here, once, for the
// device and the server alike (op-rules `withinLimit`), the same way `evaluatePermission` is.
//
// Platform-free: imports only sibling authz types.

/** The kinds of limit a store sets for a limited role. */
export const LIMIT_KINDS = ['priceDrop', 'refund', 'credit'] as const;
export type LimitKind = (typeof LIMIT_KINDS)[number];

/** A limited role's amounts at one store, in rupiah. */
export type LimitAmounts = Readonly<Record<LimitKind, number>>;

/** Every kind at Rp 0: what a limited role may do before its store sets anything. */
export const NO_LIMIT_AMOUNTS: LimitAmounts = Object.freeze({ priceDrop: 0, refund: 0, credit: 0 });

/**
 * How far someone may use a permission: not at all, or up to `limit` rupiah per servisan, where a
 * null limit is no limit. A permission with no limit kind is all or nothing.
 */
export type PermissionAllowance =
  { readonly allowed: false } | { readonly allowed: true; readonly limit: number | null };

/** Whether an allowance covers `amount`. Anything at or below zero needs only the permission. */
export function allowanceCovers(allowance: PermissionAllowance, amount: number): boolean {
  if (!allowance.allowed) return false;
  return allowance.limit === null || amount <= 0 || amount <= allowance.limit;
}

/** Read stored amounts, keeping only known kinds and whole non-negative numbers; the rest are 0. */
export function parseLimitAmounts(value: unknown): LimitAmounts {
  const source =
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const amounts = { ...NO_LIMIT_AMOUNTS };
  for (const kind of LIMIT_KINDS) {
    const amount = source[kind];
    if (typeof amount === 'number' && Number.isSafeInteger(amount) && amount > 0) {
      amounts[kind] = amount;
    }
  }
  return amounts;
}
