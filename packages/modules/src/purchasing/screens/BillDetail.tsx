/**
 * BillDetail — one supplier bill: whose nota it is, when it is due, each part at its price and
 * how it compares with its order, the total with the ongkir, and what is paid and left. It is
 * paid, corrected or voided from here, and a payment made by mistake is cancelled here.
 *
 * VoidBillStep — void a bill entered by mistake, with the reason. It stays in the history.
 */
import { formatDate, formatDateTime, formatMoney, t } from '@bolusi/i18n';
import {
  AmountRow,
  AppShell,
  Banner,
  Button,
  border,
  Card,
  Chip,
  color,
  EmptyState,
  numeric,
  space,
  Text,
  TextButton,
  TextInput,
  type,
} from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useActionRunner } from '../../screen-kit/index.js';
import {
  FlowScreen,
  QueryView,
  Section,
  type ScreenChrome,
} from '../../screen-kit/screens/views.js';
import { MAX_PURCHASING_NOTE, PURCHASING_PERMISSION } from '../constants.js';
import { tp, type PurchasingKey } from '../i18n.js';
import { billCheckKey, billLineHint, dueText, notaText } from '../bills/bill-form.js';
import type { BillDetailRow } from '../bills/queries.js';
import { dayStart } from '../../money/kas.js';
import { billStanding, paymentLine } from '../payments/pay-form.js';
import type { PaymentRow } from '../payments/queries.js';
import { usePurchasingQuery, usePurchasingRuntime } from '../runtime.js';

export interface BillDetailProps {
  readonly billId: string;
  readonly chrome: ScreenChrome;
  readonly onBack: () => void;
  readonly onEdit: (bill: BillDetailRow) => void;
  readonly onVoid: (bill: BillDetailRow) => void;
  readonly onPay: (bill: BillDetailRow) => void;
  readonly onVoidPayment: (bill: BillDetailRow, payment: PaymentRow) => void;
  readonly notice: PurchasingKey | null;
  readonly onClearNotice: () => void;
  readonly hideBack?: boolean | undefined;
  readonly testID?: string | undefined;
}

export function BillDetail({
  billId,
  chrome,
  onBack,
  onEdit,
  onVoid,
  onPay,
  onVoidPayment,
  notice,
  onClearNotice,
  hideBack = false,
  testID = 'purchasing.bill',
}: BillDetailProps): React.JSX.Element {
  const runtime = usePurchasingRuntime();
  const pays = runtime.hasPermission(PURCHASING_PERMISSION.paySuppliers);
  const [reloadNonce, setReloadNonce] = useState(0);
  const query = usePurchasingQuery(
    async (rt) => (await rt.query('getBill', { billId })).rows[0],
    `bill:${billId}:${String(reloadNonce)}`,
  );
  const bill = query.status === 'ready' ? query.data : undefined;

  return (
    <AppShell
      scrollable
      title={bill?.supplierName ?? tp('purchasing.bill.tab')}
      titleVariant="detail"
      onBack={hideBack ? undefined : onBack}
      backLabel={t('core.action.back')}
      syncChip={chrome.syncChip}
      avatar={chrome.avatar}
      bottomAction={
        bill !== undefined && bill.status === 'open' && bill.balance > 0 && pays ? (
          <Button
            label={tp('purchasing.pay.action')}
            onPress={() => onPay(bill)}
            testID={`${testID}.pay`}
          />
        ) : undefined
      }
      banner={
        notice === null ? undefined : (
          <Banner
            variant="info"
            message={tp(notice)}
            onPress={onClearNotice}
            testID={`${testID}.notice`}
          />
        )
      }
      testID={testID}
    >
      <QueryView
        query={query}
        onBack={onBack}
        onRetry={() => setReloadNonce((n) => n + 1)}
        testID={testID}
      >
        {(row) =>
          row === undefined ? (
            <EmptyState title={t('core.errors.ENTITY_NOT_FOUND')} testID={`${testID}.missing`} />
          ) : (
            renderBill(row)
          )
        }
      </QueryView>
    </AppShell>
  );

  function renderBill(row: BillDetailRow): React.JSX.Element {
    const open = row.status === 'open';
    const parts = row.total - row.charges;
    const hints = row.lines.map(billLineHint);
    const check = open ? billCheckKey(row.lines) : null;
    return (
      <View testID={`${testID}.content`}>
        <Card testID={`${testID}.summary`}>
          <View style={styles.summaryTop}>
            <Text style={styles.number}>{row.billNumber}</Text>
            {!open ? (
              <Chip
                label={tp('purchasing.bill.statusVoid')}
                icon="remove"
                tone="neutral"
                testID={`${testID}.void`}
              />
            ) : row.balance === 0 ? (
              <Chip
                label={tp('purchasing.bill.settled')}
                icon="check"
                tone="success"
                testID={`${testID}.settled`}
              />
            ) : null}
          </View>
          <Text style={styles.meta}>{notaText(row)}</Text>
          <DueLine bill={row} testID={`${testID}.due`} />
          {row.orderNumber === null ? null : (
            <Text style={styles.meta}>
              {tp('purchasing.bill.order', { number: row.orderNumber })}
            </Text>
          )}
          {row.note === null ? null : <Text style={styles.note}>{row.note}</Text>}
          {!open ? (
            <Text style={styles.meta} testID={`${testID}.voided`}>
              {[
                row.voidedAt === null
                  ? null
                  : row.voidedByName === null
                    ? tp('purchasing.bill.voided', { date: formatDateTime(row.voidedAt) })
                    : tp('purchasing.bill.voidedBy', {
                        name: row.voidedByName,
                        date: formatDateTime(row.voidedAt),
                      }),
                row.voidReason,
              ]
                .filter((part) => part !== null)
                .join(' · ')}
            </Text>
          ) : null}
        </Card>

        {check === null ? null : (
          <Text style={styles.warning} testID={`${testID}.check`}>
            {tp(check)}
          </Text>
        )}

        <Section
          title={tp('purchasing.bill.lines')}
          action={
            open ? (
              <TextButton
                label={tp('purchasing.action.edit')}
                onPress={() => onEdit(row)}
                testID={`${testID}.edit`}
              />
            ) : undefined
          }
          testID={`${testID}.lines`}
        >
          {row.lines.map((line, i) => (
            <View key={line.itemId} style={styles.line} testID={`${testID}.line.${line.itemId}`}>
              <View style={styles.lineText}>
                <Text style={styles.lineName}>{line.name}</Text>
                <Text style={styles.linePrice}>
                  {tp('purchasing.bill.linePrice', {
                    qty: line.qty,
                    price: formatMoney(line.unitPrice),
                  })}
                </Text>
                {hints[i] === null ? null : (
                  <Text style={styles.lineHint} testID={`${testID}.line.${line.itemId}.hint`}>
                    {hints[i]}
                  </Text>
                )}
              </View>
              <Text style={styles.lineAmount}>{formatMoney(line.amount)}</Text>
            </View>
          ))}
          <View style={styles.totals}>
            {row.charges === 0 ? null : (
              <>
                <AmountRow
                  label={tp('purchasing.bill.subtotal')}
                  value={parts}
                  testID={`${testID}.parts`}
                />
                <AmountRow
                  label={tp('purchasing.bill.charges')}
                  value={row.charges}
                  testID={`${testID}.charges`}
                />
              </>
            )}
            <AmountRow
              label={tp('purchasing.bill.total')}
              value={row.total}
              strong={!open || row.paid === 0}
              tone={open ? 'text' : 'struck'}
              testID={`${testID}.total`}
            />
            {open && row.paid > 0 ? (
              <>
                <AmountRow
                  label={tp('purchasing.bill.paid')}
                  value={row.paid}
                  testID={`${testID}.paid`}
                />
                <AmountRow
                  label={tp('purchasing.bill.balance')}
                  value={row.balance}
                  strong
                  testID={`${testID}.balance`}
                />
              </>
            ) : null}
          </View>
        </Section>

        {row.payments.length === 0 && row.fromCredit === 0 ? null : (
          <Section title={tp('purchasing.pay.payments')} testID={`${testID}.payments`}>
            {row.payments.map((payment) => {
              const cancelled = payment.voidedAt !== null;
              return (
                <View
                  key={payment.id}
                  style={styles.line}
                  testID={`${testID}.payment.${payment.id}`}
                >
                  <View style={styles.lineText}>
                    <Text style={styles.lineName}>{paymentLine(payment)}</Text>
                    {cancelled ? (
                      <Text style={styles.linePrice}>
                        {tp('purchasing.pay.voided', { reason: payment.voidReason ?? '' })}
                      </Text>
                    ) : pays && open ? (
                      <View style={styles.paymentAction}>
                        <TextButton
                          label={tp('purchasing.pay.void')}
                          accessibilityLabel={tp('purchasing.pay.voidLabel', {
                            amount: formatMoney(payment.amount),
                            date: formatDate(payment.createdAt),
                          })}
                          tone="danger"
                          onPress={() => onVoidPayment(row, payment)}
                          testID={`${testID}.payment.${payment.id}.void`}
                        />
                      </View>
                    ) : null}
                  </View>
                  <Text style={[styles.lineAmount, cancelled ? styles.struck : null]}>
                    {formatMoney(payment.amount)}
                  </Text>
                </View>
              );
            })}
            {row.fromCredit === 0 ? null : (
              <View style={styles.line} testID={`${testID}.fromCredit`}>
                <Text style={[styles.lineName, styles.lineText]}>
                  {tp('purchasing.bill.fromCredit')}
                </Text>
                <Text style={styles.lineAmount}>{formatMoney(row.fromCredit)}</Text>
              </View>
            )}
          </Section>
        )}
        {open && row.supplierCredit > 0 ? (
          <Text style={styles.meta} testID={`${testID}.credit`}>
            {tp('purchasing.bill.credit', { amount: formatMoney(row.supplierCredit) })}
          </Text>
        ) : null}

        <Text style={styles.recorded}>
          {row.createdByName === null
            ? tp('purchasing.bill.recordedAt', { date: formatDate(row.createdAt) })
            : tp('purchasing.bill.recorded', {
                name: row.createdByName,
                date: formatDate(row.createdAt),
              })}
        </Text>

        {open ? (
          <View style={styles.voidAction}>
            <TextButton
              label={tp('purchasing.bill.voidTitle')}
              tone="danger"
              onPress={() => onVoid(row)}
              testID={`${testID}.voidBill`}
            />
          </View>
        ) : null}
      </View>
    );
  }
}

export interface VoidBillStepProps {
  readonly chrome: ScreenChrome;
  readonly bill: BillDetailRow;
  readonly onDone: () => void;
  readonly onCancel: () => void;
  readonly testID?: string | undefined;
}

export function VoidBillStep({
  chrome,
  bill,
  onDone,
  onCancel,
  testID = 'purchasing.voidBill',
}: VoidBillStepProps): React.JSX.Element {
  const runtime = usePurchasingRuntime();
  const runner = useActionRunner();
  const [reason, setReason] = useState('');
  const save = (): void => {
    void runner
      .run(() => runtime.run('voidBill', { billId: bill.id, reason }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };
  return (
    <FlowScreen
      chrome={chrome}
      title={tp('purchasing.bill.voidTitle')}
      onBack={onCancel}
      primaryLabel={tp('purchasing.bill.voidConfirm')}
      primaryVariant="destructive"
      onPrimary={save}
      primaryDisabled={reason.trim() === ''}
      primaryHint={tp('purchasing.bill.voidReasonFirst')}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Text style={styles.value}>
        {bill.billNumber} · {bill.supplierName}
      </Text>
      <Text style={styles.meta}>{formatMoney(bill.total)}</Text>
      <Text style={[styles.meta, styles.voidHint]}>{tp('purchasing.bill.voidHint')}</Text>
      <View style={styles.reason}>
        <TextInput
          label={tp('purchasing.bill.voidReason')}
          value={reason}
          onChangeText={setReason}
          multiline
          maxLength={MAX_PURCHASING_NOTE}
          testID={`${testID}.reason`}
        />
      </View>
    </FlowScreen>
  );
}

/** When the bill falls due, as a warning once that day has passed and it is still owed. */
function DueLine({
  bill,
  testID,
}: {
  readonly bill: BillDetailRow;
  readonly testID: string;
}): React.JSX.Element {
  const late = billStanding(bill, dayStart(Date.now())).late;
  return (
    <Text style={late === null ? styles.meta : [styles.meta, styles.late]} testID={testID}>
      {late ?? dueText(bill)}
    </Text>
  );
}

const styles = StyleSheet.create({
  summaryTop: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  number: { ...type.heading, color: color.text, ...numeric, flexShrink: 0 },
  meta: { ...type.bodySm, color: color.textMuted, marginTop: space.xs },
  value: { ...type.bodyBold, color: color.text },
  note: { ...type.body, color: color.text, marginTop: space.sm },
  warning: { ...type.bodySm, color: color.warning, marginTop: space.md },
  late: { color: color.warning, fontWeight: '600' },
  line: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: border.hairline,
    borderBottomColor: color.border,
  },
  lineText: { flex: 1, gap: space.xs },
  lineName: { ...type.body, color: color.text },
  linePrice: { ...type.bodySm, color: color.textMuted, ...numeric },
  lineHint: { ...type.bodySm, color: color.warning },
  lineAmount: { ...type.body, color: color.text, ...numeric },
  struck: { color: color.textMuted, textDecorationLine: 'line-through' },
  paymentAction: { alignItems: 'flex-start', marginLeft: -space.sm },
  totals: { marginTop: space.sm },
  recorded: { ...type.caption, color: color.textMuted, marginTop: space.lg },
  voidAction: { marginTop: space['2xl'], alignItems: 'flex-start', marginLeft: -space.sm },
  voidHint: { marginTop: space.md },
  reason: { marginTop: space.lg },
});
