// Before a payment with change that looks wrong is saved (a mistyped zero: 1.750.000 handed over for
// 175.000), the counter confirms it. One hook for every screen that takes cash with change, on the
// phone and the PC alike, so none of them saves such a payment without asking.
import { formatMoney } from '@bolusi/i18n';
import { useState } from 'react';

import type { PaymentInput } from './commands.js';
import { tm } from './i18n.js';
import { changeToCheck, type ChangeToCheck } from './payment-entry.js';

export interface ChangeCheck {
  /** The change being asked about, while the confirm is open. */
  readonly asking: ChangeToCheck | null;
  /** Saves right away, or asks first when the change on `payments` looks wrong. */
  readonly guard: (payments: readonly PaymentInput[] | undefined, save: () => void) => void;
  readonly confirm: () => void;
  readonly cancel: () => void;
}

export function useChangeCheck(): ChangeCheck {
  const [pending, setPending] = useState<{
    readonly check: ChangeToCheck;
    readonly save: () => void;
  } | null>(null);
  return {
    asking: pending?.check ?? null,
    guard: (payments, save) => {
      const check = changeToCheck(payments ?? []);
      if (check === null) save();
      else setPending({ check, save });
    },
    confirm: () => {
      if (pending === null) return;
      setPending(null);
      pending.save();
    },
    cancel: () => setPending(null),
  };
}

/** The confirm's copy, already localized. */
export function changeCheckCopy(check: ChangeToCheck): {
  readonly title: string;
  readonly message: string;
  readonly confirm: string;
  readonly keep: string;
} {
  // "Rp 15.000" never splits over two lines.
  const money = (amount: number): string => formatMoney(amount).replace(' ', '\u00A0');
  return {
    title: tm('money.pay.changeCheck.title', { change: money(check.change) }),
    message: tm('money.pay.changeCheck.message', {
      tendered: money(check.tendered),
      amount: money(check.amount),
    }),
    confirm: tm('money.pay.changeCheck.confirm'),
    keep: tm('money.pay.changeCheck.keep'),
  };
}
