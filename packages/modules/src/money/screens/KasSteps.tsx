/**
 * The tasks the Kas board opens, each a full-screen step: Tutup kas (count the drawer), cash out
 * of or into the drawer with a reason, an owner settling a counted difference, and a customer
 * paying what they still owe on a phone they already took home.
 */
import { formatDateTime, formatMoney } from '@bolusi/i18n';
import { ChipRow, TextInput, ToggleChip, color, space, type } from '@bolusi/ui';
import { useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useActionRunner } from '../../screen-kit/index.js';
import { FlowScreen, type ScreenChrome } from '../../screen-kit/screens/views.js';

import { CASH_MOVE_KINDS, MAX_REASON, type CashMoveKind } from '../constants.js';
import { tm } from '../i18n.js';
import { CASH_MOVE_LABEL, differenceToSettle, type NamedBalance } from '../kas.js';
import {
  digitsOf,
  digitsText,
  newPaymentLine,
  paymentEntry,
  rupiah,
  type PaymentLine,
} from '../payment-entry.js';
import type { CashCountRow, PaymentAccountRow } from '../queries.js';
import { useMoneyQuery, useMoneyRuntime } from '../runtime.js';

import { differenceText } from './Kas.js';
import { PaymentLines } from './PaymentLines.js';

interface StepProps {
  readonly chrome: ScreenChrome;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}

function AmountField({
  label,
  digits,
  onChange,
  testID,
}: {
  readonly label: string;
  readonly digits: string;
  readonly onChange: (digits: string) => void;
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
}: StepProps & { readonly testID?: string | undefined }): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const drawer = useMoneyQuery(async (rt) => (await rt.query('cashDrawer', {})).rows[0]!, 'drawer');
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const amount = rupiah(counted);
  const expected = drawer.status === 'ready' ? drawer.data.expected : null;

  const submit = (): void => {
    if (amount === null) return;
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
      onBack={onCancel}
      primaryLabel={tm('money.count.save')}
      onPrimary={submit}
      primaryDisabled={amount === null}
      primaryHint={tm('money.count.hint')}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <AmountField
        label={tm('money.count.counted')}
        digits={counted}
        onChange={setCounted}
        testID={`${testID}.counted`}
      />
      {expected === null ? null : (
        <View style={styles.sum}>
          <Line
            label={tm('money.kas.expected')}
            value={formatMoney(expected)}
            testID={`${testID}.expected`}
          />
          {amount === null ? null : (
            <Line
              label={tm('money.count.difference')}
              value={differenceText(amount - expected)}
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
}: StepProps & { readonly testID?: string | undefined }): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const accounts = useMoneyQuery(
    async (rt) => (await rt.query('paymentAccounts', {})).rows,
    'accounts',
  );
  const [kind, setKind] = useState<CashMoveKind>('withdrawal');
  const [account, setAccount] = useState<string | null>(null);
  const [digits, setDigits] = useState('');
  const [reason, setReason] = useState('');
  const amount = rupiah(digits);
  // Cash is deposited into a bank account; QRIS and card machines settle there on their own.
  const banks: readonly PaymentAccountRow[] =
    accounts.status === 'ready' ? accounts.data.filter((row) => row.kind === 'transfer') : [];
  const depositAccount =
    kind === 'deposit'
      ? (banks.find((row) => `account:${row.id}` === account) ?? banks[0] ?? null)
      : null;
  const missing =
    amount === null || amount <= 0
      ? tm('money.move.hintAmount')
      : reason.trim() === ''
        ? tm('money.move.hintReason')
        : kind === 'deposit' && depositAccount === null
          ? tm('money.move.noAccount')
          : null;

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
      onBack={onCancel}
      primaryLabel={tm('money.move.save')}
      onPrimary={submit}
      primaryDisabled={missing !== null}
      primaryHint={missing ?? undefined}
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
}: StepProps & {
  readonly count: CashCountRow;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const drawer = useMoneyQuery(async (rt) => (await rt.query('cashDrawer', {})).rows[0]!, 'drawer');
  const [reason, setReason] = useState('');
  // The figures as they stand: a payment from before the count can sync while the owner reads.
  const counts = drawer.status === 'ready' ? drawer.data.counts : null;
  const live = counts?.find((row) => row.id === count.id) ?? count;
  const open = counts === null || differenceToSettle(counts)?.id === count.id;
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
      onBack={onCancel}
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
}: StepProps & {
  readonly balance: NamedBalance;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const accounts = useMoneyQuery(
    async (rt) => (await rt.query('paymentAccounts', {})).rows,
    'accounts',
  );
  const keys = useRef(0);
  const newKey = (): string => {
    keys.current += 1;
    return `line${String(keys.current)}`;
  };
  const [lines, setLines] = useState<readonly PaymentLine[]>(() => [
    newPaymentLine('line0', balance.balance),
  ]);
  const accountRows: readonly PaymentAccountRow[] =
    accounts.status === 'ready' ? accounts.data : [];
  const entry = paymentEntry(balance.balance, lines, accountRows);
  // Part of the debt is fine, so what is recorded is what was typed; more than the debt is not.
  const taken =
    entry.paid > 0 && entry.overpaid === 0 ? paymentEntry(entry.paid, lines, accountRows) : null;
  const ready = accounts.status === 'ready' && taken !== null && taken.complete;

  const submit = (): void => {
    if (!ready || taken === null) return;
    void runner
      .run(() =>
        runtime.run('receivePayments', {
          document: {
            kind: balance.documentKind,
            id: balance.documentId,
            label: balance.documentLabel,
          },
          payments: [...taken.payments],
        }),
      )
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tm('money.receive.title')}
      onBack={onCancel}
      primaryLabel={
        entry.paid > 0
          ? tm('money.receive.save', { amount: formatMoney(entry.paid) })
          : tm('money.receive.saveEmpty')
      }
      onPrimary={submit}
      primaryDisabled={!ready}
      primaryHint={tm('money.receive.hint')}
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
          value={formatMoney(balance.balance)}
          strong
          testID={`${testID}.owed`}
        />
      </View>
      <View style={styles.gap}>
        <PaymentLines
          lines={lines}
          entry={entry}
          accounts={accountRows}
          onChange={setLines}
          newKey={newKey}
          testID={`${testID}.pay`}
        />
      </View>
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  gap: { marginTop: space.lg },
  sum: { marginTop: space.lg, gap: space.sm },
  line: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  lineLabel: { ...type.bodySm, color: color.textMuted, flexShrink: 1, marginRight: space.md },
  lineLabelStrong: { ...type.bodyBold, color: color.text, flexShrink: 1, marginRight: space.md },
  lineValue: { ...type.bodySm, color: color.text, fontVariant: ['tabular-nums'] },
  lineValueStrong: { ...type.heading, color: color.text, fontVariant: ['tabular-nums'] },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  fieldLabel: { ...type.caption, color: color.textMuted, marginBottom: space.sm },
  muted: { ...type.bodySm, color: color.textMuted, marginTop: space.sm },
  heading: { ...type.heading, color: color.text },
});
