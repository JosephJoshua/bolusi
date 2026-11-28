/**
 * PayStep — pay a supplier for one bill: how much (what is left, to start with) and where it comes
 * from, the drawer, one of the store's bank accounts or the owner's own money.
 *
 * VoidPaymentStep — cancel a payment recorded by mistake, with the reason. It stays in the history.
 */
import { formatDate, formatMoney, keepCodeWhole } from '@bolusi/i18n';
import { color, space, Text, TextInput, ToggleChip, type } from '@bolusi/ui';
import { StyleSheet, View } from 'react-native';

import type { DiscardGuard } from '../../screen-kit/index.js';
import { useDiscardConfirm } from '../../screen-kit/screens/discard.js';
import { FlowScreen, QueryView, type ScreenChrome } from '../../screen-kit/screens/views.js';
import { acceptsRupiahText, groupedRupiah } from '../../shared/rupiah.js';
import { MAX_PAYMENT, MAX_PAYMENT_REFERENCE, MAX_PURCHASING_NOTE } from '../constants.js';
import { tp } from '../i18n.js';
import type { BillDetailRow } from '../bills/queries.js';
import { usePayForm, useVoidPayment } from '../pay.js';
import { sourceLabel } from '../payments/pay-form.js';
import type { PaymentRow } from '../payments/queries.js';

export interface PayStepProps {
  readonly chrome: ScreenChrome;
  readonly bill: BillDetailRow;
  readonly onDone: () => void;
  readonly onCancel: () => void;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID?: string | undefined;
}

/** Leaving a half-filled payment asks first, as the other purchasing steps do. */
function useLeave(
  dirty: boolean,
  onRegisterDiscardGuard: ((guard: DiscardGuard | null) => void) | undefined,
  testID: string,
) {
  return useDiscardConfirm({
    dirty,
    copy: {
      title: tp('purchasing.discard.title'),
      message: tp('purchasing.discard.message'),
      confirm: tp('purchasing.discard.confirm'),
      keep: tp('purchasing.discard.keep'),
    },
    onRegisterDiscardGuard,
    testID,
  });
}

export function PayStep({
  chrome,
  bill,
  onDone,
  onCancel,
  onRegisterDiscardGuard,
  testID = 'purchasing.pay',
}: PayStepProps): React.JSX.Element {
  const form = usePayForm(bill, onDone);
  const { draft, setDraft, runner } = form;
  const discard = useLeave(form.dirty, onRegisterDiscardGuard, testID);
  return (
    <FlowScreen
      chrome={chrome}
      title={tp('purchasing.pay.title')}
      onBack={() => discard.requestLeave(onCancel)}
      overlay={discard.overlay}
      primaryLabel={
        form.amount === null
          ? tp('purchasing.pay.action')
          : tp('purchasing.pay.save', { amount: formatMoney(form.amount) })
      }
      onPrimary={form.save}
      primaryDisabled={form.gap !== null}
      primaryHint={form.gap === null ? undefined : tp(form.gap)}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Text style={styles.value}>
        {keepCodeWhole(bill.billNumber)} · {bill.supplierName}
      </Text>
      <Text style={styles.meta}>
        {tp('purchasing.bill.balanceDue', { amount: formatMoney(bill.balance) })}
      </Text>

      <View style={styles.field}>
        <TextInput
          label={tp('purchasing.pay.amount')}
          value={draft.amount}
          onChangeText={(text) => {
            if (acceptsRupiahText(text, MAX_PAYMENT)) {
              setDraft({ ...draft, amount: groupedRupiah(text) });
            }
          }}
          keyboardType="number-pad"
          selectTextOnFocus
          testID={`${testID}.amount`}
        />
        {form.above ? (
          <Text style={styles.warning} testID={`${testID}.above`}>
            {tp('purchasing.pay.aboveBalance')}
          </Text>
        ) : null}
      </View>

      <Text style={styles.label}>{tp('purchasing.pay.source')}</Text>
      <QueryView
        query={form.sources}
        onBack={onCancel}
        onRetry={form.retrySources}
        testID={`${testID}.sources`}
      >
        {(sources) => (
          <View style={styles.sources} accessibilityRole="radiogroup" testID={`${testID}.sources`}>
            {sources.map((source) => (
              <ToggleChip
                key={source.source}
                label={sourceLabel(source)}
                selected={draft.source === source.source}
                onToggle={() => setDraft({ ...draft, source: source.source })}
                testID={`${testID}.source.${source.kind}`}
              />
            ))}
          </View>
        )}
      </QueryView>

      {form.bank ? (
        <View style={styles.field}>
          <TextInput
            label={tp('purchasing.pay.reference')}
            value={draft.reference}
            onChangeText={(reference) => setDraft({ ...draft, reference })}
            maxLength={MAX_PAYMENT_REFERENCE}
            testID={`${testID}.reference`}
          />
        </View>
      ) : null}
    </FlowScreen>
  );
}

export interface VoidPaymentStepProps {
  readonly chrome: ScreenChrome;
  readonly bill: BillDetailRow;
  readonly payment: PaymentRow;
  readonly onDone: () => void;
  readonly onCancel: () => void;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID?: string | undefined;
}

export function VoidPaymentStep({
  chrome,
  bill,
  payment,
  onDone,
  onCancel,
  onRegisterDiscardGuard,
  testID = 'purchasing.voidPayment',
}: VoidPaymentStepProps): React.JSX.Element {
  const form = useVoidPayment(payment, onDone);
  const discard = useLeave(form.ready, onRegisterDiscardGuard, testID);
  return (
    <FlowScreen
      chrome={chrome}
      title={tp('purchasing.pay.voidTitle')}
      onBack={() => discard.requestLeave(onCancel)}
      overlay={discard.overlay}
      primaryLabel={tp('purchasing.pay.voidConfirm')}
      primaryVariant="destructive"
      onPrimary={form.save}
      primaryDisabled={!form.ready}
      primaryHint={tp('purchasing.bill.voidReasonFirst')}
      busy={form.runner.busy}
      errorCode={form.runner.errorCode}
      onClearError={form.runner.clearError}
      testID={testID}
    >
      <Text style={styles.value}>
        {formatMoney(payment.amount)} · {bill.supplierName}
      </Text>
      <Text style={styles.meta}>
        {[
          formatDate(payment.createdAt),
          sourceLabel({ kind: payment.sourceKind, name: payment.accountName }),
          keepCodeWhole(bill.billNumber),
        ].join(' · ')}
      </Text>
      <Text style={[styles.meta, styles.hint]}>{tp('purchasing.pay.voidHint')}</Text>
      <View style={styles.field}>
        <TextInput
          label={tp('purchasing.bill.voidReason')}
          value={form.reason}
          onChangeText={form.setReason}
          multiline
          maxLength={MAX_PURCHASING_NOTE}
          testID={`${testID}.reason`}
        />
      </View>
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  value: { ...type.bodyBold, color: color.text },
  meta: { ...type.bodySm, color: color.textMuted, marginTop: space.xs },
  label: { ...type.bodySm, color: color.text, marginTop: space.lg, marginBottom: space.sm },
  warning: { ...type.bodySm, color: color.warning, marginTop: space.xs },
  hint: { marginTop: space.md },
  field: { marginTop: space.lg },
  // Wrapped, not scrolled: each source reads whole, the owner's own money too.
  sources: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
