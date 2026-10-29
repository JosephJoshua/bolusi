// The tasks the Kas page opens on the counter PC, each a dialog over it: Tutup kas, cash out of or
// into the drawer, an owner settling a counted difference, a customer paying a debt, money going
// back to a customer, an owner lowering a bill and an owner cancelling a payment. The rules are the phone's (kas.ts and the commands); only the layout differs.
import { formatDateTime, formatMoney } from '@bolusi/i18n';
import { Button, TextField, ToggleChip } from '@bolusi/ui-web';
import { useState } from 'react';

import { useActionRunner } from '../../screen-kit/index.js';

import {
  CASH_ACCOUNT,
  CASH_MOVE_KINDS,
  MAX_REASON,
  MAX_REFERENCE,
  MONEY_PERMISSION,
  type CashMoveKind,
} from '../constants.js';
import { tm } from '../i18n.js';
import {
  CASH_MOVE_LABEL,
  accountLabel,
  cashMoveCheck,
  differenceText,
  settleState,
  type NamedBalance,
} from '../kas.js';
import { rupiah } from '../payment-entry.js';
import type { CashCountRow, MoneyEntryRow, PaymentAccountRow } from '../queries.js';
import { canSimulateQris } from '../qris.js';
import { useDebtReceipt } from '../receive-debt.js';
import {
  reduceAmountError,
  reduceHint,
  reduceLimitText,
  refundAmountError,
  refundHint,
  refundLimitText,
  targetOf,
  useReduceCharge,
  useRefund,
  type MoneyTarget,
} from '../refund.js';
import { useMoneyQuery, useMoneyRuntime } from '../runtime.js';

import { AmountField, AmountLine, MoneyDialog } from './parts.js';
import { PaymentLines } from './PaymentLines.js';
import { QrisDialog } from './QrisDialog.js';

interface TaskProps {
  /** The task landed. */
  readonly onDone: () => void;
  readonly onClose: () => void;
}

function useDrawer() {
  return useMoneyQuery(async (rt) => (await rt.query('cashDrawer', {})).rows[0]!, 'drawer');
}

function ReasonField({
  label,
  value,
  onChange,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly testId: string;
}): React.JSX.Element {
  return (
    <TextField
      label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      maxLength={MAX_REASON}
      autoComplete="off"
      data-testid={testId}
    />
  );
}

// ── Tutup kas ──────────────────────────────────────────────────────────────────────────────────

/** Count the drawer; the difference shows before saving and is kept for an owner to settle. */
export function CountCashDialog({ onDone, onClose }: TaskProps): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const drawer = useDrawer();
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const amount = rupiah(counted);
  const expected = drawer.status === 'ready' ? drawer.data.expected : null;
  const testId = 'money.desk.count';

  const submit = (): void => {
    if (amount === null) return;
    void runner
      .run(() => runtime.run('countCash', { counted: amount, note }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  return (
    <MoneyDialog
      title={tm('money.kas.count')}
      description={tm('money.count.hint')}
      runner={runner}
      dirty={counted !== '' || note.trim() !== ''}
      onClose={onClose}
      submitLabel={tm('money.count.save')}
      onSubmit={submit}
      submitDisabled={amount === null}
      testId={testId}
    >
      <AmountField
        label={tm('money.count.counted')}
        digits={counted}
        onChange={setCounted}
        testId={`${testId}.counted`}
      />
      {expected === null ? null : (
        <div className="flex flex-col gap-2 rounded-sm bg-surface-alt p-3">
          <AmountLine
            label={tm('money.kas.expected')}
            value={formatMoney(expected)}
            testId={`${testId}.expected`}
          />
          {amount === null ? null : (
            <AmountLine
              label={tm('money.count.difference')}
              value={differenceText(amount - expected)}
              tone={amount < expected ? 'danger' : 'text'}
              strong
              testId={`${testId}.difference`}
            />
          )}
        </div>
      )}
      <ReasonField
        label={tm('money.count.note')}
        value={note}
        onChange={setNote}
        testId={`${testId}.note`}
      />
    </MoneyDialog>
  );
}

// ── cash out or in ─────────────────────────────────────────────────────────────────────────────

/** Cash taken out of the drawer or put in, with a reason; a bank deposit names its account. */
export function MoveCashDialog({ onDone, onClose }: TaskProps): React.JSX.Element {
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
  const { banks, depositAccount, missing, missingValues } = cashMoveCheck({
    kind,
    account,
    amount,
    reason,
    accounts: accounts.status === 'ready' ? accounts.data : [],
    drawer: drawer.status === 'ready' ? drawer.data.expected : null,
  });
  const testId = 'money.desk.move';

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

  return (
    <MoneyDialog
      title={tm('money.kas.move')}
      runner={runner}
      dirty={digits !== '' || reason.trim() !== ''}
      onClose={onClose}
      submitLabel={tm('money.move.save')}
      onSubmit={submit}
      submitDisabled={missing !== null}
      hint={missing === null ? null : tm(missing, missingValues)}
      size="md"
      testId={testId}
    >
      <div className="flex flex-col gap-2">
        <span className="text-small font-semibold text-text">{tm('money.move.kind')}</span>
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label={tm('money.move.kind')}
          data-testid={`${testId}.kinds`}
        >
          {CASH_MOVE_KINDS.map((option) => (
            <ToggleChip
              key={option}
              label={tm(CASH_MOVE_LABEL[option])}
              selected={kind === option}
              onToggle={() => setKind(option)}
              testId={`${testId}.kind.${option}`}
            />
          ))}
        </div>
      </div>
      {kind === 'deposit' && banks.length > 1 ? (
        <div className="flex flex-col gap-2">
          <span className="text-small font-semibold text-text">{tm('money.move.account')}</span>
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label={tm('money.move.account')}
            data-testid={`${testId}.accounts`}
          >
            {banks.map((row) => (
              <ToggleChip
                key={row.id}
                label={row.name}
                selected={depositAccount?.id === row.id}
                onToggle={() => setAccount(`account:${row.id}`)}
                testId={`${testId}.account.${row.id}`}
              />
            ))}
          </div>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <AmountField
          label={tm('money.pay.amount')}
          digits={digits}
          onChange={setDigits}
          testId={`${testId}.amount`}
        />
        <ReasonField
          label={tm('money.move.reason')}
          value={reason}
          onChange={setReason}
          testId={`${testId}.reason`}
        />
      </div>
    </MoneyDialog>
  );
}

// ── an owner settles a difference ──────────────────────────────────────────────────────────────

export function SettleCountDialog({
  count,
  onDone,
  onClose,
}: TaskProps & { readonly count: CashCountRow }): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const drawer = useDrawer();
  const [reason, setReason] = useState('');
  const { live, open } = settleState(drawer.status === 'ready' ? drawer.data.counts : null, count);
  const counter = runtime.nameOf(live.countedBy);
  const testId = 'money.desk.settle';

  const submit = (): void => {
    if (reason.trim() === '' || !open) return;
    void runner
      .run(() => runtime.run('adjustCash', { amount: live.difference, countId: live.id, reason }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  return (
    <MoneyDialog
      title={tm('money.settle.title')}
      description={
        counter === null
          ? formatDateTime(live.countedAt)
          : tm('money.settle.countedBy', { name: counter, time: formatDateTime(live.countedAt) })
      }
      runner={runner}
      dirty={reason.trim() !== ''}
      onClose={onClose}
      submitLabel={tm('money.settle.save')}
      onSubmit={submit}
      submitDisabled={reason.trim() === '' || !open}
      hint={open ? null : tm('money.settle.closed')}
      testId={testId}
    >
      <div className="flex flex-col gap-2 rounded-sm bg-surface-alt p-3">
        <AmountLine label={tm('money.kas.expected')} value={formatMoney(live.expected)} />
        <AmountLine label={tm('money.count.counted')} value={formatMoney(live.counted)} />
        <AmountLine
          label={tm('money.count.difference')}
          value={differenceText(live.difference)}
          tone={live.difference < 0 ? 'danger' : 'text'}
          strong
          testId={`${testId}.difference`}
        />
      </div>
      {live.note === null || live.note === '' ? null : (
        <p className="break-words text-body text-text-muted">{live.note}</p>
      )}
      <ReasonField
        label={tm('money.settle.reason')}
        value={reason}
        onChange={setReason}
        testId={`${testId}.reason`}
      />
    </MoneyDialog>
  );
}

// ── a customer pays a debt ─────────────────────────────────────────────────────────────────────

/** The whole debt is filled in; the counter lowers it when the customer pays only part. */
export function ReceiveDebtDialog({
  balance,
  onDone,
  onClose,
}: TaskProps & { readonly balance: NamedBalance }): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const receipt = useDebtReceipt(balance);
  const { entry, input, qris } = receipt;
  // An owner lowers the bill over this dialog, so what was typed here waits underneath.
  const [reducing, setReducing] = useState(false);
  const testId = 'money.desk.receive';

  const submit = (): void => {
    if (receipt.paidByQr) {
      onDone();
      return;
    }
    if (input === null) return;
    void runner
      .run(() => runtime.run('receivePayments', input))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  return (
    <>
      <MoneyDialog
        title={tm('money.receive.title')}
        description={[balance.customer, balance.documentLabel].filter(Boolean).join(' · ')}
        runner={runner}
        dirty={receipt.dirty && !receipt.paidByQr}
        onClose={onClose}
        submitLabel={
          receipt.paidByQr
            ? tm('money.qris.done')
            : entry.paid > 0
              ? tm('money.receive.save', { amount: formatMoney(entry.paid) })
              : tm('money.receive.saveEmpty')
        }
        onSubmit={submit}
        submitDisabled={!receipt.paidByQr && input === null}
        hint={receipt.hint}
        size="md"
        testId={testId}
      >
        <div className="rounded-sm bg-surface-alt p-3">
          <AmountLine
            label={tm('money.receive.owed')}
            value={formatMoney(receipt.owed)}
            strong
            testId={`${testId}.owed`}
          />
        </div>
        <PaymentLines
          lines={receipt.lines}
          entry={entry}
          accounts={receipt.accounts}
          onChange={receipt.setLines}
          newKey={receipt.newKey}
          qris={qris}
          testId={`${testId}.pay`}
        />
        {runtime.hasPermission(MONEY_PERMISSION.refund) ? (
          <Button
            label={tm('money.reduce.action')}
            variant="text"
            size="sm"
            className="-ml-2 self-start"
            onClick={() => setReducing(true)}
            data-testid={`${testId}.reduce`}
          />
        ) : null}
      </MoneyDialog>
      {reducing ? (
        <ReduceChargeDialog
          target={targetOf(balance)}
          // The bill it was paying changed: the board shows what is owed now.
          onDone={onDone}
          onClose={() => setReducing(false)}
        />
      ) : null}
      {qris.open !== null && runtime.qris !== undefined ? (
        <QrisDialog
          open={qris.open}
          port={runtime.qris}
          canSimulate={canSimulateQris(runtime.hasPermission)}
          onPaid={qris.paid}
          onRenew={qris.renew}
          onTakeByHand={qris.takeByHand}
          onClose={qris.close}
          testId={`${testId}.qris`}
        />
      ) : null}
    </>
  );
}

// ── money back to a customer ───────────────────────────────────────────────────────────────────

function targetText(target: MoneyTarget): string {
  return [target.customer, target.document.label].filter(Boolean).join(' · ');
}

/**
 * Money back to a customer, through a method they paid with. The counter gives back only an
 * overpayment; an owner any part of what was paid (refund.ts).
 */
export function RefundDialog({
  target,
  onDone,
  onClose,
}: TaskProps & { readonly target: MoneyTarget }): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const form = useRefund(target);
  const amount = rupiah(form.digits);
  const testId = 'money.desk.refund';
  const nothing = form.ready && form.methods.length === 0;

  const submit = (): void => {
    const { input } = form;
    if (input === null) return;
    void runner
      .run(() => runtime.run('refund', input))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  return (
    <MoneyDialog
      title={tm('money.refund.title')}
      description={targetText(target)}
      runner={runner}
      dirty={form.dirty}
      onClose={onClose}
      submitLabel={
        amount !== null && amount > 0
          ? tm('money.refund.save', { amount: formatMoney(amount) })
          : tm('money.refund.saveEmpty')
      }
      onSubmit={submit}
      submitDisabled={form.input === null}
      hint={refundHint(form)}
      size="md"
      testId={testId}
    >
      {form.owner || form.credit > 0 ? (
        <div className="flex flex-col gap-2 rounded-sm bg-surface-alt p-3">
          {form.owner ? (
            <AmountLine
              label={tm('money.refund.paid')}
              value={formatMoney(form.paid)}
              testId={`${testId}.paid`}
            />
          ) : null}
          {form.credit > 0 ? (
            <AmountLine
              label={tm('money.refund.credit')}
              value={formatMoney(form.credit)}
              strong
              testId={`${testId}.credit`}
            />
          ) : null}
        </div>
      ) : null}
      {nothing ? (
        <p className="text-body text-text-muted" data-testid={`${testId}.nothing`}>
          {tm('money.refund.nothing')}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <span className="text-small font-semibold text-text">{tm('money.refund.method')}</span>
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label={tm('money.refund.method')}
              data-testid={`${testId}.methods`}
            >
              {form.methods.map((method) => (
                <ToggleChip
                  key={method.account}
                  label={method.label}
                  selected={form.account === method.account}
                  onToggle={() => form.setAccount(method.account)}
                  testId={`${testId}.method.${method.account}`}
                />
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 items-start gap-3">
            <AmountField
              label={tm('money.refund.amount')}
              digits={form.digits}
              onChange={form.setDigits}
              error={refundAmountError(form)}
              testId={`${testId}.amount`}
            />
            {form.account === CASH_ACCOUNT || form.account === '' ? null : (
              <TextField
                label={tm('money.refund.reference')}
                value={form.reference}
                onChange={(event) => form.setReference(event.target.value)}
                maxLength={MAX_REFERENCE}
                autoComplete="off"
                data-testid={`${testId}.reference`}
              />
            )}
          </div>
          {refundLimitText(form) === null ? null : (
            <p className="text-small text-text-muted" data-testid={`${testId}.limit`}>
              {refundLimitText(form)}
            </p>
          )}
          {form.lowersBill > 0 ? (
            <p className="text-body text-text-muted" data-testid={`${testId}.lowersBill`}>
              {tm('money.refund.lowersBill', { amount: formatMoney(form.lowersBill) })}
            </p>
          ) : null}
          <ReasonField
            label={tm('money.refund.reason')}
            value={form.reason}
            onChange={form.setReason}
            testId={`${testId}.reason`}
          />
        </>
      )}
    </MoneyDialog>
  );
}

// ── an owner lowers a bill ─────────────────────────────────────────────────────────────────────

/** An owner takes (part of) what a customer owes off a bill already charged. */
export function ReduceChargeDialog({
  target,
  onDone,
  onClose,
}: TaskProps & { readonly target: MoneyTarget }): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const form = useReduceCharge(target);
  const amount = rupiah(form.digits);
  const testId = 'money.desk.reduce';

  const submit = (): void => {
    const { input } = form;
    if (input === null) return;
    void runner
      .run(() => runtime.run('reduceCharge', input))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  return (
    <MoneyDialog
      title={tm('money.reduce.title')}
      description={targetText(target)}
      runner={runner}
      dirty={form.dirty}
      onClose={onClose}
      submitLabel={
        amount !== null && amount > 0
          ? tm('money.reduce.save', { amount: formatMoney(amount) })
          : tm('money.reduce.saveEmpty')
      }
      onSubmit={submit}
      submitDisabled={form.input === null}
      hint={reduceHint(form)}
      testId={testId}
    >
      <AmountField
        label={tm('money.reduce.amount')}
        digits={form.digits}
        onChange={form.setDigits}
        error={reduceAmountError(form)}
        testId={`${testId}.amount`}
      />
      {reduceLimitText(form) === null ? null : (
        <p className="text-small text-text-muted" data-testid={`${testId}.limit`}>
          {reduceLimitText(form)}
        </p>
      )}
      <div className="flex flex-col gap-2 rounded-sm bg-surface-alt p-3">
        <AmountLine
          label={tm('money.reduce.owed')}
          value={formatMoney(Math.max(0, form.owed))}
          testId={`${testId}.owed`}
        />
        <AmountLine
          label={tm('money.reduce.after')}
          value={formatMoney(Math.max(0, form.after))}
          strong
          testId={`${testId}.after`}
        />
      </div>
      {form.after < 0 && form.problem !== 'tooMuch' ? (
        <p className="text-body text-text-muted" data-testid={`${testId}.becomesCredit`}>
          {tm('money.reduce.becomesCredit', { amount: formatMoney(-form.after) })}
        </p>
      ) : null}
      <ReasonField
        label={tm('money.reduce.reason')}
        value={form.reason}
        onChange={form.setReason}
        testId={`${testId}.reason`}
      />
    </MoneyDialog>
  );
}

// ── an owner cancels a payment ─────────────────────────────────────────────────────────────────

/** A payment recorded by mistake is cancelled with a reason; the customer's balance goes back up. */
export function VoidPaymentDialog({
  entry,
  accounts,
  onDone,
  onClose,
}: TaskProps & {
  readonly entry: MoneyEntryRow;
  readonly accounts: readonly PaymentAccountRow[];
}): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const [reason, setReason] = useState('');
  const testId = 'money.desk.void';
  const voidLimit = runtime.limitOf(MONEY_PERMISSION.voidPayment);

  const submit = (): void => {
    if (reason.trim() === '') return;
    void runner
      .run(() => runtime.run('voidPayment', { entryId: entry.id, reason }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  return (
    <MoneyDialog
      title={tm('money.void.title')}
      runner={runner}
      dirty={reason.trim() !== ''}
      onClose={onClose}
      submitLabel={tm('money.void.save')}
      onSubmit={submit}
      submitDisabled={reason.trim() === ''}
      destructive
      testId={testId}
    >
      <div className="flex flex-col gap-1 rounded-sm bg-surface-alt p-3">
        <span className="tabular text-title font-bold text-text" data-testid={`${testId}.amount`}>
          {formatMoney(entry.amount)}
        </span>
        <span className="text-body text-text-muted">
          {[
            accountLabel(entry.account ?? '', accounts),
            entry.documentLabel,
            formatDateTime(entry.createdAt),
          ]
            .filter((part) => part !== null && part !== '')
            .join(' · ')}
        </span>
      </div>
      <p className="text-body text-text">{tm('money.void.explain')}</p>
      {voidLimit === null ? null : (
        <p className="text-small text-text-muted" data-testid={`${testId}.limit`}>
          {tm('money.void.limit', { amount: formatMoney(voidLimit) })}
        </p>
      )}
      <ReasonField
        label={tm('money.void.reason')}
        value={reason}
        onChange={setReason}
        testId={`${testId}.reason`}
      />
    </MoneyDialog>
  );
}
