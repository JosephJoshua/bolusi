// The tasks the Kas page opens on the counter PC, each a dialog over it: Tutup kas, cash out of or
// into the drawer, an owner settling a counted difference, a customer paying a debt and an owner
// cancelling a payment. The rules are the phone's (kas.ts and the commands); only the layout differs.
import { formatDateTime, formatMoney } from '@bolusi/i18n';
import { TextField, ToggleChip } from '@bolusi/ui-web';
import { useState } from 'react';

import { useActionRunner } from '../../screen-kit/index.js';

import { CASH_MOVE_KINDS, MAX_REASON, MONEY_PERMISSION, type CashMoveKind } from '../constants.js';
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
      </MoneyDialog>
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
