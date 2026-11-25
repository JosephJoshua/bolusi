/**
 * BillDetail — one supplier bill: whose nota it is, when it is due, each part at its price and
 * how it compares with its order, and the total with the ongkir. It is corrected or voided from
 * here.
 *
 * VoidBillStep — void a bill entered by mistake, with the reason. It stays in the history.
 */
import { formatDate, formatDateTime, formatMoney, t } from '@bolusi/i18n';
import {
  AmountRow,
  AppShell,
  Banner,
  border,
  Card,
  Chip,
  color,
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
import { MAX_PURCHASING_NOTE } from '../constants.js';
import { tp, type PurchasingKey } from '../i18n.js';
import { billLineHint, dueText, notaText } from '../bills/bill-form.js';
import type { BillDetailRow } from '../bills/queries.js';
import { usePurchasingQuery, usePurchasingRuntime } from '../runtime.js';

export interface BillDetailProps {
  readonly billId: string;
  readonly chrome: ScreenChrome;
  readonly onBack: () => void;
  readonly onEdit: (bill: BillDetailRow) => void;
  readonly onVoid: (bill: BillDetailRow) => void;
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
  notice,
  onClearNotice,
  hideBack = false,
  testID = 'purchasing.bill',
}: BillDetailProps): React.JSX.Element {
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
        {(row) => (row === undefined ? null : renderBill(row))}
      </QueryView>
    </AppShell>
  );

  function renderBill(row: BillDetailRow): React.JSX.Element {
    const open = row.status === 'open';
    const parts = row.total - row.charges;
    const hints = row.lines.map(billLineHint);
    return (
      <View testID={`${testID}.content`}>
        <Card testID={`${testID}.summary`}>
          <View style={styles.summaryTop}>
            <Text style={styles.number}>{row.billNumber}</Text>
            {open ? null : (
              <Chip
                label={tp('purchasing.bill.statusVoid')}
                icon="remove"
                tone="neutral"
                testID={`${testID}.void`}
              />
            )}
          </View>
          <Text style={styles.meta}>{notaText(row)}</Text>
          <Text style={styles.meta}>{dueText(row)}</Text>
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

        {open && hints.some((hint) => hint !== null) ? (
          <Text style={styles.warning} testID={`${testID}.check`}>
            {tp('purchasing.bill.checkHint')}
          </Text>
        ) : null}

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
            <AmountRow
              label={tp('purchasing.bill.subtotal')}
              value={parts}
              testID={`${testID}.parts`}
            />
            {row.charges === 0 ? null : (
              <AmountRow
                label={tp('purchasing.bill.charges')}
                value={row.charges}
                testID={`${testID}.charges`}
              />
            )}
            <AmountRow
              label={tp('purchasing.bill.total')}
              value={row.total}
              strong
              tone={open ? 'text' : 'struck'}
              testID={`${testID}.total`}
            />
          </View>
        </Section>

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
  totals: { marginTop: space.sm },
  recorded: { ...type.caption, color: color.textMuted, marginTop: space.lg },
  voidAction: { marginTop: space['2xl'], alignItems: 'flex-start', marginLeft: -space.sm },
  voidHint: { marginTop: space.md },
  reason: { marginTop: space.lg },
});
