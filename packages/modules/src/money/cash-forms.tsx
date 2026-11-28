// The cash drawer's own steps, the same on the phone and the PC: counting it, moving money in or
// out of it, and settling a count that came out different. Each app only draws the form.
import { useState } from 'react';

import { useActionRunner } from '../screen-kit/index.js';

import {
  cashCountView,
  cashMoveCheck,
  NEW_CASH_COUNT,
  seesExpected,
  settleState,
  type CashCountForm,
} from './kas.js';
import type { CashMoveKind } from './constants.js';
import { rupiah } from './payment-entry.js';
import type { CashCountRow } from './queries.js';
import { useMoneyQuery, useMoneyRuntime, type MoneyRuntime } from './runtime.js';

/** The drawer as the ledger has it: what should be in it, and its counts. */
export function useDrawer() {
  return useMoneyQuery(async (rt) => (await rt.query('cashDrawer', {})).rows[0]!, 'drawer');
}

/** A Kasir counts blind: what should be in the drawer is not shown to them. */
function countsBlind(runtime: MoneyRuntime): boolean {
  return !seesExpected(
    (id) => runtime.hasPermission(id),
    (id) => runtime.limitOf(id),
  );
}

/** Counting the drawer: an amount that is off is checked once, and then needs a note. */
export function useCashCount(onDone: () => void) {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const drawer = useDrawer();
  const [form, setForm] = useState<CashCountForm>(NEW_CASH_COUNT);
  const [note, setNote] = useState('');
  const view = cashCountView(
    form,
    drawer.status === 'ready' ? drawer.data.expected : null,
    countsBlind(runtime),
  );
  const { amount } = view;
  const noteMissing = view.noteRequired && note.trim() === '';
  const submit = (): void => {
    if (amount === null) return;
    if (view.next === 'check') {
      setForm({ ...form, checked: true });
      return;
    }
    if (noteMissing) return;
    void runner
      .run(() => runtime.run('countCash', { counted: amount, note }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };
  return {
    runner,
    drawer,
    form,
    setForm,
    note,
    setNote,
    view,
    amount,
    noteMissing,
    dirty: form.counted !== '' || note.trim() !== '',
    submit,
  };
}

/** Taking money out of the drawer or putting it in, to a bank account where it goes to one. */
export function useCashMove(onDone: () => void) {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const accounts = useMoneyQuery(
    async (rt) => (await rt.query('paymentAccounts', {})).rows,
    'accounts',
  );
  const drawer = useDrawer();
  const [kind, setKind] = useState<CashMoveKind>('withdrawal');
  const [account, setAccount] = useState<string | null>(null);
  const [digits, setDigits] = useState('');
  const [reason, setReason] = useState('');
  const amount = rupiah(digits);
  const check = cashMoveCheck({
    kind,
    account,
    amount,
    reason,
    accounts: accounts.status === 'ready' ? accounts.data : [],
    drawer: drawer.status === 'ready' ? drawer.data.expected : null,
    blind: countsBlind(runtime),
  });
  const { depositAccount, missing } = check;
  const submit = (): void => {
    if (missing !== null || amount === null) return;
    void runner
      .run(() =>
        runtime.run('moveCash', {
          kind,
          amount,
          reason,
          account: depositAccount === null ? null : `account:${depositAccount.id}`,
        }),
      )
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };
  return {
    runner,
    accounts,
    drawer,
    kind,
    setKind,
    account,
    setAccount,
    digits,
    setDigits,
    reason,
    setReason,
    amount,
    ...check,
    dirty: digits !== '' || reason.trim() !== '',
    submit,
  };
}

/** Settling a count that came out different, as the latest copy of that count has it. */
export function useSettleCount(count: CashCountRow, onDone: () => void) {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const drawer = useDrawer();
  const [reason, setReason] = useState('');
  const { live, open } = settleState(drawer.status === 'ready' ? drawer.data.counts : null, count);
  const submit = (): void => {
    if (reason.trim() === '' || !open) return;
    void runner
      .run(() => runtime.run('adjustCash', { amount: live.difference, countId: live.id, reason }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };
  return {
    runner,
    drawer,
    reason,
    setReason,
    live,
    open,
    counter: runtime.nameOf(live.countedBy),
    submit,
  };
}
