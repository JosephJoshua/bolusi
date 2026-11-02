/**
 * The tasks the Kas board opens, each a full-screen step: Tutup kas (count the drawer), cash out
 * of or into the drawer with a reason, an owner settling a counted difference, a customer paying
 * what they still owe on a phone they already took home, money going back to a customer, and an
 * owner lowering a bill.
 */
import { formatDateTime, formatMoney } from '@bolusi/i18n';
import {
  ChipRow,
  EmptyState,
  TextButton,
  TextInput,
  ToggleChip,
  color,
  space,
  type,
  Text,
} from '@bolusi/ui';
import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { useActionRunner, type DiscardGuard } from '../../screen-kit/index.js';
import { useDiscardConfirm } from '../../screen-kit/screens/discard.js';
import { FlowScreen, type ScreenChrome } from '../../screen-kit/screens/views.js';

import {
  CASH_ACCOUNT,
  CASH_MOVE_KINDS,
  MAX_REASON,
  MAX_REFERENCE,
  MONEY_PERMISSION,
  type CashMoveKind,
} from '../constants.js';
import { ta } from '../../approvals/i18n.js';
import { tm } from '../i18n.js';
import {
  CASH_MOVE_LABEL,
  cashCountView,
  cashMoveCheck,
  differenceText,
  NEW_CASH_COUNT,
  RECOUNT_CASH,
  seesExpected,
  settleState,
  type CashCountForm,
  type NamedBalance,
} from '../kas.js';
import { digitsOf, digitsText, rupiah } from '../payment-entry.js';
import { canSimulateQris } from '../qris.js';
import type { CashCountRow } from '../queries.js';
import { useDebtReceipt } from '../receive-debt.js';
import {
  reduceAmountError,
  reduceHint,
  reduceLimitText,
  refundAmountError,
  refundHint,
  refundLimitText,
  useReduceCharge,
  useRefund,
  type MoneyTarget,
} from '../refund.js';
import { useMoneyQuery, useMoneyRuntime } from '../runtime.js';

import { PaymentLines } from './PaymentLines.js';
import { QrisStep, useQrStepBack } from './QrisStep.js';

interface StepProps {
  readonly chrome: ScreenChrome;
  readonly onDone: () => void;
  readonly onCancel: () => void;
  /** Hardware back asks through this while something typed would be lost. */
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
}

/** Leaving a step with something typed asks first, from the header back and hardware back alike. */
function useStepLeave(
  dirty: boolean,
  { onCancel, onRegisterDiscardGuard }: StepProps,
  testID: string,
): { readonly onBack: () => void; readonly overlay: ReactNode } {
  const discard = useDiscardConfirm({
    dirty,
    copy: {
      title: tm('money.discard.title'),
      message: tm('money.discard.message'),
      confirm: tm('money.discard.confirm'),
      keep: tm('money.discard.keep'),
    },
    onRegisterDiscardGuard,
    testID,
  });
  return { onBack: () => discard.requestLeave(onCancel), overlay: discard.overlay };
}

function AmountField({
  label,
  digits,
  onChange,
  errorMessage,
  testID,
}: {
  readonly label: string;
  readonly digits: string;
  readonly onChange: (digits: string) => void;
  readonly errorMessage?: string | undefined;
  readonly testID: string;
}): React.JSX.Element {
  return (
    <TextInput
      label={label}
      value={digitsText(digits)}
      onChangeText={(text) => {
        const typed = digitsOf(text);
        if (typed !== null) onChange(typed);
      }}
      keyboardType="number-pad"
      selectTextOnFocus
      errorMessage={errorMessage}
      testID={testID}
    />
  );
}

/** A label and its amount on one line. */
function Line({
  label,
  value,
  strong = false,
  testID,
}: {
  readonly label: string;
  readonly value: string;
  readonly strong?: boolean | undefined;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  return (
    <View style={styles.line}>
      <Text style={strong ? styles.lineLabelStrong : styles.lineLabel}>{label}</Text>
      <Text style={strong ? styles.lineValueStrong : styles.lineValue} testID={testID}>
        {value}
      </Text>
    </View>
  );
}

// ── Tutup kas ──────────────────────────────────────────────────────────────────────────────────

/**
 * Count the drawer. The book's figure is shown so the counter sees the difference before saving;
 * a difference is kept as it is, for an owner to settle.
 */
export function CountCashStep({
  chrome,
  onDone,
  onCancel,
  testID = 'money.count',
  onRegisterDiscardGuard,
}: StepProps & { readonly testID?: string | undefined }): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const drawer = useMoneyQuery(async (rt) => (await rt.query('cashDrawer', {})).rows[0]!, 'drawer');
  const [form, setForm] = useState<CashCountForm>(NEW_CASH_COUNT);
  const [note, setNote] = useState('');
  const leave = useStepLeave(
    form.counted !== '' || note.trim() !== '',
    { chrome, onDone, onCancel, onRegisterDiscardGuard },
    testID,
  );
  const blind = !seesExpected(
    (id) => runtime.hasPermission(id),
    (id) => runtime.limitOf(id),
  );
  const view = cashCountView(form, drawer.status === 'ready' ? drawer.data.expected : null, blind);
  const { amount } = view;

  const submit = (): void => {
    if (amount === null) return;
    if (view.next === 'check') {
      setForm({ ...form, checked: true });
      return;
    }
    void runner
      .run(() => runtime.run('countCash', { counted: amount, note }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tm('money.kas.count')}
      onBack={leave.onBack}
      overlay={leave.overlay}
      primaryLabel={tm(view.next === 'check' ? 'money.count.check' : 'money.count.save')}
      onPrimary={submit}
      primaryDisabled={amount === null}
      primaryHint={tm('money.count.hint')}
      secondary={
        view.mayRecount
          ? {
              label: tm('money.count.recount'),
              onPress: () => setForm(RECOUNT_CASH),
              testID: `${testID}.recount`,
            }
          : undefined
      }
      question={view.mayRecount ? tm('money.count.recountHint') : undefined}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      {view.locked && amount !== null ? (
        <View style={styles.sum}>
          <Line
            label={tm('money.count.counted')}
            value={formatMoney(amount)}
            strong
            testID={`${testID}.countedValue`}
          />
        </View>
      ) : (
        <AmountField
          label={tm('money.count.counted')}
          digits={form.counted}
          onChange={(counted) => setForm({ ...form, counted })}
          testID={`${testID}.counted`}
        />
      )}
      {view.expected === null ? null : (
        <View style={styles.sum}>
          <Line
            label={tm('money.kas.expected')}
            value={formatMoney(view.expected)}
            testID={`${testID}.expected`}
          />
          {view.difference === null ? null : (
            <Line
              label={tm('money.count.difference')}
              value={differenceText(view.difference)}
              strong
              testID={`${testID}.difference`}
            />
          )}
        </View>
      )}
      <View style={styles.gap}>
        <TextInput
          label={tm('money.count.note')}
          value={note}
          onChangeText={setNote}
          maxLength={MAX_REASON}
          testID={`${testID}.note`}
        />
      </View>
    </FlowScreen>
  );
}

// ── cash out or in ─────────────────────────────────────────────────────────────────────────────

/** Cash taken out of the drawer or put in, with a reason; a bank deposit names its account. */
export function MoveCashStep({
  chrome,
  onDone,
  onCancel,
  testID = 'money.move',
  onRegisterDiscardGuard,
}: StepProps & { readonly testID?: string | undefined }): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const accounts = useMoneyQuery(
    async (rt) => (await rt.query('paymentAccounts', {})).rows,
    'accounts',
  );
  const drawer = useMoneyQuery(async (rt) => (await rt.query('cashDrawer', {})).rows[0]!, 'drawer');
  const [kind, setKind] = useState<CashMoveKind>('withdrawal');
  const [account, setAccount] = useState<string | null>(null);
  const [digits, setDigits] = useState('');
  const [reason, setReason] = useState('');
  const leave = useStepLeave(
    digits !== '' || reason.trim() !== '',
    { chrome, onDone, onCancel, onRegisterDiscardGuard },
    testID,
  );
  const amount = rupiah(digits);
  const { banks, depositAccount, missing, missingValues } = cashMoveCheck({
    kind,
    account,
    amount,
    reason,
    accounts: accounts.status === 'ready' ? accounts.data : [],
    drawer: drawer.status === 'ready' ? drawer.data.expected : null,
    blind: !seesExpected(
      (id) => runtime.hasPermission(id),
      (id) => runtime.limitOf(id),
    ),
  });

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
    <FlowScreen
      chrome={chrome}
      title={tm('money.kas.move')}
      onBack={leave.onBack}
      overlay={leave.overlay}
      primaryLabel={tm('money.move.save')}
      onPrimary={submit}
      primaryDisabled={missing !== null}
      primaryHint={missing === null ? undefined : tm(missing, missingValues)}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Text style={styles.fieldLabel}>{tm('money.move.kind')}</Text>
      {/* Four fixed choices: wrapped, so every one stays in view. */}
      <View style={styles.wrap} testID={`${testID}.kinds`}>
        {CASH_MOVE_KINDS.map((option) => (
          <ToggleChip
            key={option}
            label={tm(CASH_MOVE_LABEL[option])}
            selected={kind === option}
            onToggle={() => setKind(option)}
            testID={`${testID}.kind.${option}`}
          />
        ))}
      </View>
      {kind === 'deposit' && banks.length > 1 ? (
        <View style={styles.gap}>
          <Text style={styles.fieldLabel}>{tm('money.move.account')}</Text>
          <ChipRow testID={`${testID}.accounts`}>
            {banks.map((row) => (
              <ToggleChip
                key={row.id}
                label={row.name}
                selected={depositAccount?.id === row.id}
                onToggle={() => setAccount(`account:${row.id}`)}
                testID={`${testID}.account.${row.id}`}
              />
            ))}
          </ChipRow>
        </View>
      ) : null}
      <View style={styles.gap}>
        <AmountField
          label={tm('money.pay.amount')}
          digits={digits}
          onChange={setDigits}
          testID={`${testID}.amount`}
        />
      </View>
      <View style={styles.gap}>
        <TextInput
          label={tm('money.move.reason')}
          value={reason}
          onChangeText={setReason}
          maxLength={MAX_REASON}
          testID={`${testID}.reason`}
        />
      </View>
    </FlowScreen>
  );
}

// ── an owner settles a difference ──────────────────────────────────────────────────────────────

/** An owner settles one count's difference, so the book matches the drawer again. */
export function SettleCountStep({
  chrome,
  count,
  onDone,
  onCancel,
  testID = 'money.settle',
  onRegisterDiscardGuard,
}: StepProps & {
  readonly count: CashCountRow;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const drawer = useMoneyQuery(async (rt) => (await rt.query('cashDrawer', {})).rows[0]!, 'drawer');
  const [reason, setReason] = useState('');
  const leave = useStepLeave(
    reason.trim() !== '',
    { chrome, onDone, onCancel, onRegisterDiscardGuard },
    testID,
  );
  const { live, open } = settleState(drawer.status === 'ready' ? drawer.data.counts : null, count);
  const counter = runtime.nameOf(live.countedBy);

  const submit = (): void => {
    if (reason.trim() === '' || !open) return;
    void runner
      .run(() => runtime.run('adjustCash', { amount: live.difference, countId: live.id, reason }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tm('money.settle.title')}
      onBack={leave.onBack}
      overlay={leave.overlay}
      primaryLabel={tm('money.settle.save')}
      onPrimary={submit}
      primaryDisabled={reason.trim() === '' || !open}
      primaryHint={open ? tm('money.settle.hint') : tm('money.settle.closed')}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      {counter === null ? null : (
        <Text style={styles.muted}>
          {tm('money.settle.countedBy', { name: counter, time: formatDateTime(live.countedAt) })}
        </Text>
      )}
      <View style={styles.sum}>
        <Line label={tm('money.kas.expected')} value={formatMoney(live.expected)} />
        <Line label={tm('money.count.counted')} value={formatMoney(live.counted)} />
        <Line
          label={tm('money.count.difference')}
          value={differenceText(live.difference)}
          strong
          testID={`${testID}.difference`}
        />
      </View>
      {live.note === null || live.note === '' ? null : (
        <Text style={styles.muted}>{live.note}</Text>
      )}
      <View style={styles.gap}>
        <TextInput
          label={tm('money.settle.reason')}
          value={reason}
          onChangeText={setReason}
          maxLength={MAX_REASON}
          testID={`${testID}.reason`}
        />
      </View>
    </FlowScreen>
  );
}

// ── a customer pays a debt ─────────────────────────────────────────────────────────────────────

/**
 * A customer pays (part of) what they still owe on a phone they already took home. The whole debt
 * is filled in; the counter lowers it when the customer pays only part.
 */
export function ReceiveDebtStep({
  chrome,
  balance,
  onDone,
  onCancel,
  testID = 'money.receive',
  onRegisterDiscardGuard,
  onReduce,
}: StepProps & {
  readonly balance: NamedBalance;
  /** An owner lowers the bill instead (absent: not offered). */
  readonly onReduce?: (() => void) | undefined;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const receipt = useDebtReceipt(balance);
  const { entry, input, qris } = receipt;
  const leave = useStepLeave(
    receipt.dirty && !receipt.paidByQr,
    {
      chrome,
      onDone,
      onCancel,
      onRegisterDiscardGuard: useQrStepBack(onRegisterDiscardGuard, qris.open !== null, qris.close),
    },
    testID,
  );

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

  if (qris.open !== null && runtime.qris !== undefined) {
    return (
      <QrisStep
        chrome={chrome}
        open={qris.open}
        port={runtime.qris}
        canSimulate={canSimulateQris(runtime.hasPermission)}
        onPaid={qris.paid}
        onRenew={qris.renew}
        onTakeByHand={qris.takeByHand}
        onClose={qris.close}
        testID={`${testID}.qris`}
      />
    );
  }

  return (
    <FlowScreen
      chrome={chrome}
      title={tm('money.receive.title')}
      onBack={leave.onBack}
      overlay={leave.overlay}
      primaryLabel={
        receipt.paidByQr
          ? tm('money.qris.done')
          : entry.paid > 0
            ? tm('money.receive.save', { amount: formatMoney(entry.paid) })
            : tm('money.receive.saveEmpty')
      }
      onPrimary={submit}
      primaryDisabled={!receipt.paidByQr && input === null}
      primaryHint={receipt.hint ?? undefined}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Text style={styles.heading}>{balance.customer ?? balance.documentLabel}</Text>
      {balance.customer === null ? null : <Text style={styles.muted}>{balance.documentLabel}</Text>}
      <View style={styles.sum}>
        <Line
          label={tm('money.receive.owed')}
          value={formatMoney(receipt.owed)}
          strong
          testID={`${testID}.owed`}
        />
      </View>
      <View style={styles.gap}>
        <PaymentLines
          lines={receipt.lines}
          entry={entry}
          accounts={receipt.accounts}
          onChange={receipt.setLines}
          newKey={receipt.newKey}
          qris={qris}
          testID={`${testID}.pay`}
        />
      </View>
      {onReduce === undefined || !runtime.hasPermission(MONEY_PERMISSION.refund) ? null : (
        <View style={[styles.gap, styles.textAction]}>
          <TextButton
            label={tm('money.reduce.action')}
            onPress={onReduce}
            testID={`${testID}.reduce`}
          />
        </View>
      )}
    </FlowScreen>
  );
}

// ── money back to a customer ───────────────────────────────────────────────────────────────────

/**
 * Money back to a customer, through a method they paid with. The counter gives back only an
 * overpayment; an owner any part of what was paid (refund.ts).
 */
export function RefundStep({
  chrome,
  target,
  onDone,
  onCancel,
  onAsked,
  testID = 'money.refund',
  onRegisterDiscardGuard,
}: StepProps & {
  readonly target: MoneyTarget;
  /** Beyond a manager's limit an owner is asked instead, and this runs once asked. */
  readonly onAsked?: (() => void) | undefined;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const form = useRefund(target, onAsked !== undefined);
  const leave = useStepLeave(
    form.dirty,
    { chrome, onDone, onCancel, onRegisterDiscardGuard },
    testID,
  );
  const amount = rupiah(form.digits);

  const submit = (): void => {
    const { input, ask } = form;
    const save =
      ask !== null
        ? () => runtime.approvals.run('requestApproval', ask)
        : input !== null
          ? () => runtime.run('refund', input)
          : null;
    if (save === null) return;
    void runner.run<unknown>(save).then((result) => {
      if (result !== undefined) (ask !== null ? (onAsked ?? onDone) : onDone)();
    });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tm('money.refund.title')}
      onBack={leave.onBack}
      overlay={leave.overlay}
      primaryLabel={
        form.asking
          ? ta('approvals.action.ask')
          : amount !== null && amount > 0
            ? tm('money.refund.save', { amount: formatMoney(amount) })
            : tm('money.refund.saveEmpty')
      }
      onPrimary={submit}
      primaryDisabled={form.input === null && form.ask === null}
      primaryHint={refundHint(form) ?? undefined}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Text style={styles.heading}>{target.customer ?? target.document.label}</Text>
      {target.customer === null ? null : <Text style={styles.muted}>{target.document.label}</Text>}
      <View style={styles.sum}>
        {form.owner ? (
          <Line
            label={tm('money.refund.paid')}
            value={formatMoney(form.paid)}
            testID={`${testID}.paid`}
          />
        ) : null}
        {form.credit > 0 ? (
          <Line
            label={tm('money.refund.credit')}
            value={formatMoney(form.credit)}
            strong
            testID={`${testID}.credit`}
          />
        ) : null}
      </View>
      {form.ready && form.methods.length === 0 ? (
        <EmptyState title={tm('money.refund.nothing')} testID={`${testID}.nothing`} />
      ) : (
        <>
          <View style={styles.gap}>
            <Text style={styles.fieldLabel}>{tm('money.refund.method')}</Text>
            <ChipRow testID={`${testID}.methods`}>
              {form.methods.map((method) => (
                <ToggleChip
                  key={method.account}
                  label={method.label}
                  selected={form.account === method.account}
                  onToggle={() => form.setAccount(method.account)}
                  testID={`${testID}.method.${method.account}`}
                />
              ))}
            </ChipRow>
          </View>
          <View style={styles.gap}>
            <AmountField
              label={tm('money.refund.amount')}
              digits={form.digits}
              onChange={form.setDigits}
              errorMessage={refundAmountError(form)}
              testID={`${testID}.amount`}
            />
            {refundLimitText(form) === null ? null : (
              <Text style={styles.muted} testID={`${testID}.limit`}>
                {refundLimitText(form)}
              </Text>
            )}
            {form.lowersBill > 0 ? (
              <Text style={styles.muted} testID={`${testID}.lowersBill`}>
                {tm('money.refund.lowersBill', { amount: formatMoney(form.lowersBill) })}
              </Text>
            ) : null}
          </View>
          {form.account === CASH_ACCOUNT || form.account === '' ? null : (
            <View style={styles.gap}>
              <TextInput
                label={tm('money.refund.reference')}
                value={form.reference}
                onChangeText={form.setReference}
                maxLength={MAX_REFERENCE}
                autoCorrect={false}
                autoCapitalize="characters"
                testID={`${testID}.reference`}
              />
            </View>
          )}
          <View style={styles.gap}>
            <TextInput
              label={tm('money.refund.reason')}
              value={form.reason}
              onChangeText={form.setReason}
              maxLength={MAX_REASON}
              testID={`${testID}.reason`}
            />
          </View>
        </>
      )}
    </FlowScreen>
  );
}

// ── an owner lowers a bill ─────────────────────────────────────────────────────────────────────

/** An owner takes (part of) what a customer owes off a bill already charged. */
export function ReduceChargeStep({
  chrome,
  target,
  onDone,
  onCancel,
  onAsked,
  testID = 'money.reduce',
  onRegisterDiscardGuard,
}: StepProps & {
  readonly target: MoneyTarget;
  /** Beyond a manager's limit an owner is asked instead, and this runs once asked. */
  readonly onAsked?: (() => void) | undefined;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const form = useReduceCharge(target, onAsked !== undefined);
  const leave = useStepLeave(
    form.dirty,
    { chrome, onDone, onCancel, onRegisterDiscardGuard },
    testID,
  );
  const amount = rupiah(form.digits);

  const submit = (): void => {
    const { input, ask } = form;
    const save =
      ask !== null
        ? () => runtime.approvals.run('requestApproval', ask)
        : input !== null
          ? () => runtime.run('reduceCharge', input)
          : null;
    if (save === null) return;
    void runner.run<unknown>(save).then((result) => {
      if (result !== undefined) (ask !== null ? (onAsked ?? onDone) : onDone)();
    });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tm('money.reduce.title')}
      onBack={leave.onBack}
      overlay={leave.overlay}
      primaryLabel={
        form.asking
          ? ta('approvals.action.ask')
          : amount !== null && amount > 0
            ? tm('money.reduce.save', { amount: formatMoney(amount) })
            : tm('money.reduce.saveEmpty')
      }
      onPrimary={submit}
      primaryDisabled={form.input === null && form.ask === null}
      primaryHint={reduceHint(form) ?? undefined}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Text style={styles.heading}>{target.customer ?? target.document.label}</Text>
      {target.customer === null ? null : <Text style={styles.muted}>{target.document.label}</Text>}
      <View style={styles.sum}>
        <Line
          label={tm('money.reduce.owed')}
          value={formatMoney(Math.max(0, form.owed))}
          testID={`${testID}.owed`}
        />
      </View>
      <View style={styles.gap}>
        <AmountField
          label={tm('money.reduce.amount')}
          digits={form.digits}
          onChange={form.setDigits}
          errorMessage={reduceAmountError(form)}
          testID={`${testID}.amount`}
        />
        {reduceLimitText(form) === null ? null : (
          <Text style={styles.muted} testID={`${testID}.limit`}>
            {reduceLimitText(form)}
          </Text>
        )}
      </View>
      <View style={styles.sum}>
        <Line
          label={tm('money.reduce.after')}
          value={formatMoney(Math.max(0, form.after))}
          strong
          testID={`${testID}.after`}
        />
        {form.after < 0 && form.problem !== 'tooMuch' ? (
          <Text style={styles.muted} testID={`${testID}.becomesCredit`}>
            {tm('money.reduce.becomesCredit', { amount: formatMoney(-form.after) })}
          </Text>
        ) : null}
      </View>
      <View style={styles.gap}>
        <TextInput
          label={tm('money.reduce.reason')}
          value={form.reason}
          onChangeText={form.setReason}
          maxLength={MAX_REASON}
          testID={`${testID}.reason`}
        />
      </View>
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  gap: { marginTop: space.lg },
  textAction: { alignItems: 'flex-start', marginLeft: -space.sm },
  sum: { marginTop: space.lg, gap: space.sm },
  line: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  lineLabel: { ...type.bodySm, color: color.textMuted, flexShrink: 1, marginRight: space.md },
  lineLabelStrong: { ...type.bodyBold, color: color.text, flexShrink: 1, marginRight: space.md },
  // The amount never wraps: "Rp" and its figure stay on one line, the label wraps instead.
  lineValue: { ...type.bodySm, color: color.text, fontVariant: ['tabular-nums'], flexShrink: 0 },
  lineValueStrong: {
    ...type.heading,
    color: color.text,
    fontVariant: ['tabular-nums'],
    flexShrink: 0,
  },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  fieldLabel: { ...type.caption, color: color.textMuted, marginBottom: space.sm },
  muted: { ...type.bodySm, color: color.textMuted, marginTop: space.sm },
  heading: { ...type.heading, color: color.text },
});
