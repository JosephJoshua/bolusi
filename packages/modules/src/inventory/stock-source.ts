// Where parts that arrive in a store come from, and who says whether they did.
//
// As with part uses (part-use.ts), stock never reads another workflow's records. The module that
// owns a source (purchasing, for a receipt from a supplier) supplies a check, and the composition
// root (`@bolusi/modules`) wires each kind to it. The receive rule runs it on the device and on the
// server, so only parts a receipt really lists can come into stock, once, and in its quantity.
import type { Kysely } from 'kysely';

import type { OpRuleContext } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import type { StockSourceKind } from './constants.js';

export interface StockSourceCheck {
  readonly op: SignedOperation;
  readonly sourceId: string;
  readonly itemId: string;
  readonly qty: number;
  /** The judging side's projection. A source reads only its own module's tables. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each source types its own tables
  readonly db: Kysely<any>;
  readonly holdsPermission: OpRuleContext<unknown>['holdsPermission'];
}

export interface StockSourceTarget {
  /**
   * Refuse (throw the owning module's refusal) unless this source brought `qty` of this part into
   * the op's store. Returns how the source reads in stock history (an order number), which the op
   * must carry.
   */
  check(input: StockSourceCheck): Promise<{ readonly label: string }>;
}

export type StockSourceTargets = Readonly<Record<StockSourceKind, StockSourceTarget>>;
