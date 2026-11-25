/**
 * BillForm — a supplier's nota recorded as a bill, or one being corrected: who it is from (the
 * order's supplier when it bills an order), the supplier's own number and date, when it must be
 * paid, each part with its price, and the ongkir. The draft is held by the surface, so picking a
 * part and coming back keeps it.
 */
import { formatMoney, formatPhone, keepNumbersWhole } from '@bolusi/i18n';
import {
  AmountRow,
  border,
  ChipRow,
  color,
  ListRow,
  QuantityStepper,
  space,
  Text,
  TextButton,
  TextInput,
  ToggleChip,
  type,
} from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useActionRunner, type DiscardGuard } from '../../screen-kit/index.js';
import { useDiscardConfirm } from '../../screen-kit/screens/discard.js';
import {
  FlowScreen,
  QueryView,
  Section,
  type ScreenChrome,
} from '../../screen-kit/screens/views.js';
import { groupedRupiah, keepsRupiahText } from '../../shared/rupiah-text.js';
import {
  MAX_BILL_CHARGES,
  MAX_LINE_QTY,
  MAX_PURCHASING_NOTE,
  MAX_SUPPLIER_REF,
  MAX_UNIT_PRICE,
} from '../constants.js';
import { tp } from '../i18n.js';
import {
  BILL_TERMS,
  billGap,
  billInput,
  draftTotal,
  dueOnOf,
  dueText,
  linePrice,
  removeBillLine,
  setBillLine,
  type BillDraft,
  type BilledDay,
} from '../bills/bill-form.js';
import { usePurchasingQuery, usePurchasingRuntime } from '../runtime.js';

export interface BillFormProps {
  readonly chrome: ScreenChrome;
  /** The bill being corrected; absent for a new one. */
  readonly billId?: string | undefined;
  readonly draft: BillDraft;
  readonly onChange: (draft: BillDraft) => void;
  readonly onPickPart: () => void;
  readonly onDone: (billId: string) => void;
  readonly onCancel: () => void;
  readonly dirty: boolean;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  /** The clock, for "today" (tests and the preview pass their own). */
  readonly now?: (() => number) | undefined;
  readonly testID?: string | undefined;
}

const DAYS: readonly BilledDay[] = ['today', 'yesterday', 'other'];

export function BillForm({
  chrome,
  billId,
  draft,
  onChange,
  onPickPart,
  onDone,
  onCancel,
  dirty,
  onRegisterDiscardGuard,
  now = Date.now,
  testID = 'purchasing.billForm',
}: BillFormProps): React.JSX.Element {
  const runtime = usePurchasingRuntime();
  const runner = useActionRunner();
  const discard = useDiscardConfirm({
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
  const [reloadNonce, setReloadNonce] = useState(0);
  const suppliers = usePurchasingQuery(
    async (rt) => (await rt.query('listSuppliers', {})).rows,
    `billSuppliers:${String(reloadNonce)}`,
  );
  const at = now();
  const gap = billGap(draft, at);
  const due = dueOnOf(draft, at);

  const save = (): void => {
    if (gap !== null) return;
    const input = billInput(draft, at);
    void runner
      .run(async () =>
        billId === undefined
          ? (await runtime.run('recordBill', input)).billId
          : (await runtime.run('editBill', { billId, ...input })).billId,
      )
      .then((saved) => {
        if (saved !== undefined) onDone(saved);
      });
  };

  const amountField = (text: string, max: number): string | null =>
    keepsRupiahText(text, max) ? groupedRupiah(text) : null;

  return (
    <FlowScreen
      chrome={chrome}
      title={tp(billId === undefined ? 'purchasing.bill.newTitle' : 'purchasing.bill.editTitle')}
      onBack={() => discard.requestLeave(onCancel)}
      overlay={discard.overlay}
      primaryLabel={tp('purchasing.bill.save')}
      onPrimary={save}
      primaryDisabled={gap !== null}
      primaryHint={gap === null ? undefined : tp(gap)}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Section title={tp('purchasing.bill.supplier')} first testID={`${testID}.supplier`}>
        <QueryView
          query={suppliers}
          onBack={onCancel}
          onRetry={() => setReloadNonce((n) => n + 1)}
          testID={`${testID}.suppliers`}
        >
          {(rows) =>
            draft.orderId !== null ? (
              // A bill for an order is from the order's supplier.
              <View testID={`${testID}.fromOrder`}>
                <Text style={styles.value}>
                  {rows.find((row) => row.id === draft.supplierId)?.name ?? ''}
                </Text>
                <Text style={styles.muted}>
                  {tp('purchasing.bill.order', { number: draft.orderNumber ?? '' })}
                </Text>
              </View>
            ) : rows.length === 0 ? (
              <Text style={styles.muted}>{tp('purchasing.form.noSuppliers')}</Text>
            ) : (
              <View style={styles.bleed}>
                {rows.map((row) => (
                  <ListRow
                    key={row.id}
                    primaryText={row.name}
                    secondaryText={
                      row.phone === null ? undefined : keepNumbersWhole(formatPhone(row.phone))
                    }
                    selected={draft.supplierId === row.id}
                    onPress={() => onChange({ ...draft, supplierId: row.id })}
                    testID={`${testID}.supplier.${row.id}`}
                  />
                ))}
              </View>
            )
          }
        </QueryView>
      </Section>

      <View style={styles.field}>
        <TextInput
          label={tp('purchasing.bill.supplierRef')}
          value={draft.supplierRef}
          onChangeText={(supplierRef) => onChange({ ...draft, supplierRef })}
          maxLength={MAX_SUPPLIER_REF}
          autoCapitalize="characters"
          testID={`${testID}.supplierRef`}
        />
      </View>

      <Section title={tp('purchasing.bill.billedOn')} testID={`${testID}.billedOn`}>
        <ChipRow testID={`${testID}.days`}>
          {DAYS.map((day) => (
            <ToggleChip
              key={day}
              label={tp(
                day === 'today'
                  ? 'purchasing.bill.today'
                  : day === 'yesterday'
                    ? 'purchasing.bill.yesterday'
                    : 'purchasing.bill.otherDay',
              )}
              selected={draft.billedDay === day}
              onToggle={() => onChange({ ...draft, billedDay: day })}
              testID={`${testID}.day.${day}`}
            />
          ))}
        </ChipRow>
        {draft.billedDay === 'other' ? (
          <View style={styles.field}>
            <TextInput
              label={tp('purchasing.bill.dateField')}
              value={draft.billedText}
              onChangeText={(billedText) => onChange({ ...draft, billedText })}
              keyboardType="numbers-and-punctuation"
              maxLength={10}
              testID={`${testID}.date`}
            />
          </View>
        ) : null}
      </Section>

      <Section title={tp('purchasing.bill.terms')} testID={`${testID}.terms`}>
        <ChipRow testID={`${testID}.termChips`}>
          {[...BILL_TERMS, 'other' as const].map((term) => (
            <ToggleChip
              key={String(term)}
              label={
                term === 0
                  ? tp('purchasing.bill.termNone')
                  : term === 'other'
                    ? tp('purchasing.bill.termOther')
                    : tp('purchasing.bill.termDays', { count: term })
              }
              selected={draft.term === term}
              onToggle={() => onChange({ ...draft, term })}
              testID={`${testID}.term.${String(term)}`}
            />
          ))}
        </ChipRow>
        {draft.term === 'other' ? (
          <View style={styles.field}>
            <TextInput
              label={tp('purchasing.bill.termDaysField')}
              value={draft.termDays}
              onChangeText={(termDays) =>
                onChange({ ...draft, termDays: termDays.replace(/\D/g, '').slice(0, 3) })
              }
              keyboardType="number-pad"
              testID={`${testID}.termDays`}
            />
          </View>
        ) : null}
        {due === null ? null : (
          <Text style={styles.caption} testID={`${testID}.due`}>
            {dueText({ dueOn: due })}
          </Text>
        )}
      </Section>

      <Section
        title={tp('purchasing.bill.lines')}
        action={
          <TextButton
            label={tp('purchasing.form.addPart')}
            onPress={onPickPart}
            testID={`${testID}.addPart`}
          />
        }
        testID={`${testID}.lines`}
      >
        {draft.lines.length === 0 ? (
          <Text style={styles.muted}>{tp('purchasing.form.noParts')}</Text>
        ) : (
          draft.lines.map((line) => {
            const price = linePrice(line);
            return (
              <View key={line.itemId} style={styles.line} testID={`${testID}.line.${line.itemId}`}>
                <View style={styles.lineTop}>
                  <Text style={styles.lineName}>{line.name}</Text>
                  <TextButton
                    label={tp('purchasing.form.remove')}
                    accessibilityLabel={`${tp('purchasing.form.remove')} ${line.name}`}
                    tone="danger"
                    onPress={() => onChange(removeBillLine(draft, line.itemId))}
                    testID={`${testID}.line.${line.itemId}.remove`}
                  />
                </View>
                <QuantityStepper
                  label={tp('purchasing.form.qty')}
                  value={line.qty}
                  onChange={(qty) => onChange(setBillLine(draft, line.itemId, { qty }))}
                  min={1}
                  max={MAX_LINE_QTY}
                  decreaseLabel={tp('purchasing.form.decrease')}
                  increaseLabel={tp('purchasing.form.increase')}
                  testID={`${testID}.line.${line.itemId}.qty`}
                />
                <TextInput
                  label={tp('purchasing.bill.price')}
                  value={line.price}
                  onChangeText={(text) => {
                    const kept = amountField(text, MAX_UNIT_PRICE);
                    if (kept !== null) onChange(setBillLine(draft, line.itemId, { price: kept }));
                  }}
                  keyboardType="number-pad"
                  selectTextOnFocus
                  testID={`${testID}.line.${line.itemId}.price`}
                />
                {price === null ? null : (
                  <Text style={styles.caption} testID={`${testID}.line.${line.itemId}.amount`}>
                    {tp('purchasing.bill.lineAmount', {
                      qty: line.qty,
                      price: formatMoney(price),
                      amount: formatMoney(line.qty * price),
                    })}
                  </Text>
                )}
              </View>
            );
          })
        )}
      </Section>

      <View style={styles.field}>
        <TextInput
          label={tp('purchasing.bill.charges')}
          value={draft.charges}
          onChangeText={(text) => {
            const kept = amountField(text, MAX_BILL_CHARGES);
            if (kept !== null) onChange({ ...draft, charges: kept });
          }}
          keyboardType="number-pad"
          selectTextOnFocus
          testID={`${testID}.charges`}
        />
      </View>
      <View style={styles.field}>
        <TextInput
          label={tp('purchasing.bill.note')}
          value={draft.note}
          onChangeText={(note) => onChange({ ...draft, note })}
          multiline
          maxLength={MAX_PURCHASING_NOTE}
          testID={`${testID}.note`}
        />
      </View>
      <View style={styles.total}>
        <AmountRow
          label={tp('purchasing.bill.total')}
          value={draftTotal(draft)}
          strong
          testID={`${testID}.total`}
        />
      </View>
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  field: { marginTop: space.md },
  muted: { ...type.bodySm, color: color.textMuted },
  value: { ...type.bodyBold, color: color.text },
  caption: { ...type.bodySm, color: color.textMuted, marginTop: space.sm },
  bleed: { marginHorizontal: -space.lg },
  line: {
    paddingVertical: space.md,
    gap: space.sm,
    borderBottomWidth: border.hairline,
    borderBottomColor: color.border,
  },
  lineTop: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  lineName: { ...type.bodyBold, color: color.text, flex: 1 },
  total: { marginTop: space.xl },
});
