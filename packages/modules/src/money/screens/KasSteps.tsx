/**
 * The tasks the Kas board opens, each a full-screen step: Tutup kas (count the drawer), cash out
 * of or into the drawer with a reason, an owner settling a counted difference, a customer paying
 * what they still owe on a phone they already took home, money going back to a customer, and an
 * owner lowering a bill.
 */
import { useReceiveDebt } from '../receive-debt.js';
import { useCashCount, useCashMove, useSettleCount } from '../cash-forms.js';
import { formatDateTime, formatMoney } from '@bolusi/i18n';
import {
  color,
  EmptyState,
  numeric,
  SegmentedControl,
  space,
  Text,
  TextButton,
  TextInput,
  type,
} from '@bolusi/ui';
import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { type DiscardGuard } from '../../screen-kit/index.js';
import { useDiscardConfirm } from '../../screen-kit/screens/discard.js';
import { FlowScreen, type ScreenChrome } from '../../screen-kit/screens/views.js';

import {
  CASH_ACCOUNT,
  CASH_MOVE_KINDS,
  MAX_REASON,
  MAX_REFERENCE,
  MONEY_PERMISSION,
} from '../constants.js';
import { ta } from '../../approvals/i18n.js';
import { tm } from '../i18n.js';
import { CASH_MOVE_LABEL, differenceText, RECOUNT_CASH, type NamedBalance } from '../kas.js';
import { digitsOf, digitsText, rupiah } from '../payment-entry.js';
import { canSimulateQris } from '../qris.js';
import type { CashCountRow } from '../queries.js';
import {
  reduceAmountError,
  reduceHint,
  reduceLimitText,
  refundAmountError,
  refundHint,
  refundLimitText,
  useReduceCharge,
  useRefund,
} from '../refund.js';
import type { MoneyTarget } from '../kas.js';
import { useMoneyRuntime } from '../runtime.js';

import { ChangeCheckSheet, PaymentLines } from './PaymentLines.js';
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
  const { runner, form, setForm, note, setNote, view, amount, noteMissing, submit, dirty } =
    useCashCount(onDone);
  const leave = useStepLeave(dirty, { chrome, onDone, onCancel, onRegisterDiscardGuard }, testID);

  return (
    <FlowScreen
      chrome={chrome}
      title={tm('money.kas.count')}
      onBack={leave.onBack}
      overlay={leave.overlay}
      primaryLabel={tm(view.next === 'check' ? 'money.count.check' : 'money.count.save')}
      onPrimary={submit}
      primaryDisabled={amount === null || noteMissing}
      primaryHint={tm(noteMissing ? 'money.count.reasonHint' : 'money.count.hint')}
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
          label={tm(view.noteRequired ? 'money.count.reason' : 'money.count.note')}
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
  const move = useCashMove(onDone);
  const { runner, kind, setKind, setAccount, digits, setDigits } = move;
  const { reason, setReason, banks, depositAccount, missing, missingValues, submit } = move;
  const leave = useStepLeave(
    move.dirty,
    { chrome, onDone, onCancel, onRegisterDiscardGuard },
    testID,
  );

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
      <SegmentedControl
        options={CASH_MOVE_KINDS.map((option) => ({
          value: option,
          label: tm(CASH_MOVE_LABEL[option]),
        }))}
        value={kind}
        onChange={setKind}
        testID={`${testID}.kind`}
      />
      {kind === 'deposit' && banks.length > 1 ? (
        <View style={styles.gap}>
          <Text style={styles.fieldLabel}>{tm('money.move.account')}</Text>
          <SegmentedControl
            options={banks.map((row) => ({ value: row.id, label: row.name }))}
            value={depositAccount?.id ?? ''}
            onChange={(id) => setAccount(`account:${id}`)}
            testID={`${testID}.account`}
          />
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
  const { runner, reason, setReason, live, open, counter, submit } = useSettleCount(count, onDone);
  const leave = useStepLeave(
    reason.trim() !== '',
    { chrome, onDone, onCancel, onRegisterDiscardGuard },
    testID,
  );

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
  const { receipt, runner, changeCheck, submit } = useReceiveDebt(balance, onDone);
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
        onCancel={qris.cancelOpen}
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
      overlay={
        <>
          {leave.overlay}
          <ChangeCheckSheet check={changeCheck} testID={testID} />
        </>
      }
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
 * overpayment; an owner any part of what was paid (refund.tsx).
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
  const form = useRefund(target, { onDone, onAsked });
  const { runner, submit } = form;
  const leave = useStepLeave(
    form.dirty,
    { chrome, onDone, onCancel, onRegisterDiscardGuard },
    testID,
  );
  const amount = rupiah(form.digits);

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
            <SegmentedControl
              options={form.methods.map((method) => ({
                value: method.account,
                label: method.label,
              }))}
              value={form.account}
              onChange={form.setAccount}
              testID={`${testID}.method`}
            />
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
  const form = useReduceCharge(target, { onDone, onAsked });
  const { runner, submit } = form;
  const leave = useStepLeave(
    form.dirty,
    { chrome, onDone, onCancel, onRegisterDiscardGuard },
    testID,
  );
  const amount = rupiah(form.digits);

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
  lineValue: { ...type.bodySm, color: color.text, ...numeric, flexShrink: 0 },
  lineValueStrong: {
    ...type.heading,
    color: color.text,
    ...numeric,
    flexShrink: 0,
  },
  fieldLabel: { ...type.caption, color: color.textMuted, marginBottom: space.sm },
  muted: { ...type.bodySm, color: color.textMuted, marginTop: space.sm },
  heading: { ...type.heading, color: color.text },
});
