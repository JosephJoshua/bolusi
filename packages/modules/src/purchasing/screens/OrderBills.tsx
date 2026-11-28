/**
 * OrderBills — the supplier's bills for one order, on the order's page, for whoever reads bills:
 * each with its total and when it is due, and the way to record the next one.
 */
import { keepCodeWhole } from '@bolusi/i18n';
import { AmountRow, color, Text, TextButton, type, Rows } from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet } from 'react-native';

import { QueryView, Section } from '../../screen-kit/screens/views.js';
import { tp } from '../i18n.js';
import { dueText, notaText } from '../bills/bill-form.js';
import type { OrderDetailRow } from '../queries.js';
import { usePurchasingQuery } from '../runtime.js';

export function OrderBills({
  order,
  onNewBill,
  onOpenBill,
  onBack,
  testID,
}: {
  readonly order: OrderDetailRow;
  readonly onNewBill: () => void;
  readonly onOpenBill: (billId: string) => void;
  /** Leaves the order, when the bills cannot be read here. */
  readonly onBack: () => void;
  readonly testID: string;
}): React.JSX.Element {
  const [reloadNonce, setReloadNonce] = useState(0);
  const query = usePurchasingQuery(
    async (rt) =>
      (await rt.query('listBills', { filter: 'open', orderId: order.id, limit: 100, offset: 0 }))
        .rows,
    `orderBills:${order.id}:${String(reloadNonce)}`,
  );
  return (
    <Section
      title={tp('purchasing.bill.orderBills')}
      action={
        <TextButton
          label={tp('purchasing.bill.new')}
          onPress={onNewBill}
          testID={`${testID}.new`}
        />
      }
      testID={testID}
    >
      <QueryView
        query={query}
        onBack={onBack}
        onRetry={() => setReloadNonce((n) => n + 1)}
        testID={testID}
      >
        {(rows) =>
          rows.length === 0 ? (
            <Text style={styles.muted}>{tp('purchasing.bill.orderNoBills')}</Text>
          ) : (
            <Rows>
              {rows.map((row) => (
                <AmountRow
                  key={row.id}
                  label={`${keepCodeWhole(row.billNumber)} · ${notaText(row)}`}
                  detail={dueText(row)}
                  value={row.total}
                  onPress={() => onOpenBill(row.id)}
                  testID={`${testID}.row.${row.id}`}
                />
              ))}
              {rows.length > 1 ? (
                <AmountRow
                  label={tp('purchasing.bill.total')}
                  value={rows.reduce((sum, row) => sum + row.total, 0)}
                  strong
                  testID={`${testID}.total`}
                />
              ) : null}
            </Rows>
          )
        }
      </QueryView>
    </Section>
  );
}

const styles = StyleSheet.create({
  muted: { ...type.bodySm, color: color.textMuted },
});
