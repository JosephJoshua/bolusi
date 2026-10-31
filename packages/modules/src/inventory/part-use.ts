// What parts are taken for, and who says whether they may be.
//
// Stock is a ledger other workflows draw on, so it never reads their records itself. The module
// that owns a use (repair, for a servisan) supplies a check, and the composition root
// (`@bolusi/modules`) wires each kind to its check. The take and put-back rules run it on the device
// and on the server, so whether a servisan may draw parts is decided by repair's own rules.
import type { Kysely } from 'kysely';

import type { OpRuleContext } from '@bolusi/core';
import type { SignedOperation } from '@bolusi/schemas';

import type { PartUseKind } from './constants.js';

/** What the parts are for, as the stock rules record it. */
export interface PartUse {
  readonly kind: PartUseKind;
  readonly id: string;
  /** How it reads in stock history: the servisan number. */
  readonly label: string;
}

export interface PartUseCheck {
  readonly op: SignedOperation;
  readonly useId: string;
  readonly action: 'take' | 'putBack';
  /** The judging side's projection. A target reads only its own module's tables. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each target types its own tables
  readonly db: Kysely<any>;
  readonly holdsPermission: OpRuleContext<unknown>['holdsPermission'];
}

export interface PartUseTarget {
  /**
   * Refuse (throw the owning module's refusal) when this user may not take or put back parts for
   * this use now. Returns how the use reads in lists (a servisan number), which the op must carry.
   */
  check(input: PartUseCheck): Promise<{ readonly label: string }>;
}

export type PartUseTargets = Readonly<Record<PartUseKind, PartUseTarget>>;
