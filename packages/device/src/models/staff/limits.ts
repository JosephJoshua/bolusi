/**
 * "Batas wewenang": how far a limited role (a manager) may go at this store, per servisan, set by
 * the store owner (product-scope.md, "Managers, limits, approvals and roles"). Shared by the phone
 * and the counter PC; the server checks the same bounds again (`PutRoleLimitsReq`).
 */
import {
  LIMIT_KINDS,
  settableLimitRoles,
  type LimitAmounts,
  type LimitKind,
  type StaffActor,
  type StaffDirectory,
  type StaffRole,
} from '@bolusi/core';
import { ROLE_LIMIT_MAX } from '@bolusi/schemas';

/** What is typed in each amount field: digits only, so an emptied field stays empty. */
export type LimitsText = Readonly<Record<LimitKind, string>>;

export function limitsText(limits: LimitAmounts): LimitsText {
  return {
    priceDrop: String(limits.priceDrop),
    refund: String(limits.refund),
    credit: String(limits.credit),
  };
}

/** Whole rupiah from a field; null when empty or above what the server takes. */
export function parseLimit(text: string): number | null {
  const digits = text.replace(/\D/g, '');
  if (digits === '') return null;
  const value = Number(digits);
  return value <= ROLE_LIMIT_MAX ? value : null;
}

/** Keep a keystroke only when the field still reads as an amount the server takes. */
export function acceptsLimitText(text: string): boolean {
  return text.replace(/\D/g, '') === '' || parseLimit(text) !== null;
}

/** The three amounts once every field is filled in; null while one is empty. */
export function parseLimits(text: LimitsText): LimitAmounts | null {
  const priceDrop = parseLimit(text.priceDrop);
  const refund = parseLimit(text.refund);
  const credit = parseLimit(text.credit);
  if (priceDrop === null || refund === null || credit === null) return null;
  return { priceDrop, refund, credit };
}

export function sameLimits(a: LimitAmounts, b: LimitAmounts): boolean {
  return LIMIT_KINDS.every((kind) => a[kind] === b[kind]);
}

/** A limited role with its amounts here, as the screens list it. */
export type LimitRole = StaffRole & { readonly limits: LimitAmounts };

/** The limited roles this owner may set here (never one they hold). */
export function limitRoles(directory: StaffDirectory, actor: StaffActor): readonly LimitRole[] {
  return settableLimitRoles(directory, actor).filter(
    (role): role is LimitRole => role.limits !== null,
  );
}

/** Each amount's label and what it covers, in the order the form asks for them. */
export const LIMIT_FIELDS = [
  { kind: 'priceDrop', label: 'auth.limits.priceDrop', hint: 'auth.limits.priceDropHint' },
  { kind: 'refund', label: 'auth.limits.refund', hint: 'auth.limits.refundHint' },
  { kind: 'credit', label: 'auth.limits.credit', hint: 'auth.limits.creditHint' },
] as const satisfies readonly {
  readonly kind: LimitKind;
  readonly label: string;
  readonly hint: string;
}[];
