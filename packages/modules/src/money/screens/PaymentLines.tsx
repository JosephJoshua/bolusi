/**
 * PaymentLines — taking a payment at the counter on a phone: for each method, its chip, the
 * amount, and what that method needs (cash handed over for the change, an EDC's approval code).
 * "Tambah metode lain" splits the bill. The arithmetic is `paymentEntry`, shared with the PC.
 * A field still empty is not an error: the bottom bar's hint says what is missing. Only a value
 * that cannot be right (less cash than the amount) is marked. On a QRIS method connected to Xendit
 * the line shows its QR instead (`qris`, QrisSheet), unless the counter takes it by hand.
 */
import { formatMoney } from '@bolusi/i18n';
import { QRIS_MIN_AMOUNT } from '@bolusi/schemas';
import {
  Button,
  ChipRow,
  TextButton,
  TextInput,
  ToggleChip,
  border,
  color,
  space,
  type,
} from '@bolusi/ui';
import { StyleSheet, Text, View } from 'react-native';

import { referenceRequired } from '../constants.js';
import { tm } from '../i18n.js';
import {
  digitsOf,
  digitsText,
  lineKind,
  newPaymentLine,
  offeredAccount,
  paidByQr,
  paymentMethods,
  type PaymentEntry,
  type PaymentLine,
} from '../payment-entry.js';
import type { PaymentAccountRow } from '../queries.js';
import { qrAmountOk, unresolvedText, type QrisCheckout } from '../qris-hooks.js';

export interface PaymentLinesProps {
  readonly lines: readonly PaymentLine[];
  readonly entry: PaymentEntry;
  /** The store's methods besides cash, active and usable here. */
  readonly accounts: readonly PaymentAccountRow[];
  readonly onChange: (lines: readonly PaymentLine[]) => void;
  /** Where a line's key comes from, so a screen keeps keys stable across renders. */
  readonly newKey: () => string;
  /** QRIS through Xendit; absent where payments are only taken by hand. */
  readonly qris?: QrisCheckout | undefined;
  readonly testID?: string | undefined;
}

export function PaymentLines({
  lines,
  entry,
  accounts,
  onChange,
  newKey,
  qris,
  testID = 'money.payment',
}: PaymentLinesProps): React.JSX.Element {
  const methods = paymentMethods(accounts);
  const labelOf = (account: string) =>
    methods.find((method) => method.account === account)?.label ?? tm('money.method.cash');
  const set = (key: string, patch: Partial<PaymentLine>) =>
    onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const digits = (key: string, field: 'amount' | 'tendered') => (text: string) => {
    const typed = digitsOf(text);
    if (typed !== null) set(key, { [field]: typed });
  };

  return (
    <View style={styles.lines} testID={testID}>
      {qris !== undefined && qris.received > 0 ? (
        <Text style={styles.received} testID={`${testID}.qrisReceived`}>
          {tm('money.qris.received', { amount: formatMoney(qris.received) })}
        </Text>
      ) : null}
      {qris !== undefined && qris.unresolved.length > 0 ? (
        <Text style={styles.unresolved} testID={`${testID}.qrisUnresolved`}>
          {unresolvedText(qris.unresolved)}
        </Text>
      ) : null}
      {lines.map((line, index) => {
        const id = `${testID}.line${String(index)}`;
        const account = offeredAccount(line.account, accounts);
        const kind = lineKind(account, accounts);
        const problem = entry.problems[line.key];
        const amount = Number(line.amount === '' ? 0 : line.amount);
        const tendered = Number(line.tendered === '' ? 0 : line.tendered);
        const connected = qris?.qrAccounts.has(account) === true;
        const byQr = connected && paidByQr(line, qris.qrAccounts);
        return (
          <View key={line.key} style={[styles.line, index > 0 && styles.nextLine]} testID={id}>
            {methods.length > 1 ? (
              <ChipRow testID={`${id}.methods`}>
                {methods.map((method) => (
                  <ToggleChip
                    key={method.account}
                    label={method.label}
                    selected={account === method.account}
                    onToggle={() =>
                      set(line.key, {
                        account: method.account,
                        tendered: '',
                        reference: '',
                        qr: undefined,
                        manual: false,
                      })
                    }
                    testID={`${id}.method.${method.account}`}
                  />
                ))}
              </ChipRow>
            ) : null}
            <TextInput
              label={tm('money.pay.amount')}
              value={digitsText(line.amount)}
              onChangeText={digits(line.key, 'amount')}
              keyboardType="number-pad"
              testID={`${id}.amount`}
            />
            {kind === 'cash' ? (
              <View style={styles.field}>
                <TextInput
                  label={tm('money.pay.tendered')}
                  value={digitsText(line.tendered)}
                  onChangeText={digits(line.key, 'tendered')}
                  keyboardType="number-pad"
                  errorMessage={
                    problem === 'tendered' ? tm('money.pay.problem.tendered') : undefined
                  }
                  testID={`${id}.tendered`}
                />
                {line.tendered !== '' && tendered >= amount && amount > 0 ? (
                  <View style={styles.changeRow}>
                    <Text style={styles.changeLabel}>{tm('money.pay.change')}</Text>
                    <Text style={styles.changeValue} testID={`${id}.change`}>
                      {formatMoney(tendered - amount)}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : byQr ? (
              <View style={styles.qr}>
                <Button
                  label={tm('money.qris.show')}
                  variant="secondary"
                  size="compact"
                  disabled={!qrAmountOk(line) || entry.overpaid > 0}
                  onPress={() => qris.show(line.key)}
                  testID={`${id}.showQr`}
                />
              </View>
            ) : (
              <View style={styles.field}>
                <TextInput
                  label={tm(
                    referenceRequired(kind) ? 'money.pay.approvalCode' : 'money.pay.reference',
                  )}
                  value={line.reference}
                  onChangeText={(reference) => set(line.key, { reference })}
                  autoCorrect={false}
                  autoCapitalize="characters"
                  testID={`${id}.reference`}
                />
                {connected && line.manual !== true ? (
                  <Text style={styles.qrNote} testID={`${id}.qrMinimum`}>
                    {tm('money.qris.minimum', { amount: formatMoney(QRIS_MIN_AMOUNT) })}
                  </Text>
                ) : connected ? (
                  <View style={styles.lineAction}>
                    <TextButton
                      label={tm('money.qris.useQr')}
                      onPress={() => qris.useQr(line.key)}
                      testID={`${id}.useQr`}
                    />
                  </View>
                ) : null}
              </View>
            )}
            {lines.length > 1 ? (
              <View style={styles.lineAction}>
                <TextButton
                  label={tm('money.pay.remove')}
                  accessibilityLabel={tm('money.pay.removeLabel', {
                    method: labelOf(account),
                  })}
                  tone="danger"
                  onPress={() => onChange(lines.filter((other) => other.key !== line.key))}
                  testID={`${id}.remove`}
                />
              </View>
            ) : null}
          </View>
        );
      })}
      {entry.remaining > 0 && lines.length > 0 && lines.length < 10 ? (
        <View style={styles.remaining}>
          <Text style={styles.remainingText} testID={`${testID}.remaining`}>
            {tm('money.pay.remaining', { amount: formatMoney(entry.remaining) })}
          </Text>
        </View>
      ) : null}
      {entry.overpaid > 0 ? (
        <Text style={styles.overpaid} testID={`${testID}.overpaid`}>
          {tm('money.pay.overpaid', { amount: formatMoney(entry.overpaid) })}
        </Text>
      ) : null}
      {methods.length > 1 && lines.length < 10 ? (
        <View style={styles.add}>
          <TextButton
            label={tm('money.pay.addMethod')}
            icon="add"
            onPress={() => {
              const used = new Set(lines.map((line) => line.account));
              const next = methods.find((method) => !used.has(method.account))?.account;
              onChange([...lines, newPaymentLine(newKey(), entry.remaining, next)]);
            }}
            testID={`${testID}.add`}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  lines: { gap: space.xl },
  line: { gap: space.md },
  // A split's later methods sit under a hairline, so each reads as its own payment.
  nextLine: {
    paddingTop: space.xl,
    borderTopWidth: border.hairline,
    borderTopColor: color.border,
  },
  lineAction: { alignItems: 'flex-start', marginLeft: -space.sm, marginTop: -space.sm },
  field: { gap: space.sm },
  changeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: space.md,
  },
  changeLabel: { ...type.bodySm, color: color.textMuted, flexShrink: 1 },
  changeValue: { ...type.bodyBold, color: color.text, fontVariant: ['tabular-nums'] },
  qr: { gap: space.sm, alignItems: 'flex-start' },
  qrNote: { ...type.bodySm, color: color.textMuted },
  received: { ...type.bodySm, color: color.success },
  unresolved: { ...type.bodySm, color: color.warning },
  remaining: { marginTop: -space.md },
  remainingText: { ...type.bodySm, color: color.textMuted },
  overpaid: { ...type.bodySm, color: color.danger, marginTop: -space.md },
  // The text, not the hit box, lines up with the fields above.
  add: { alignItems: 'flex-start', marginLeft: -space.sm, marginTop: -space.md },
});
