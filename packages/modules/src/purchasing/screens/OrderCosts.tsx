/**
 * What an order's deliveries cost, for people who may see buy prices ("Lihat harga beli"): each
 * part of each delivery with its price per piece and line total, the total so far, and a way to
 * fill in a price that was left for later or fix one. Read apart from the order, so on a store
 * device holding no costs the order still opens and only this section says it needs internet.
 */
import { formatMoney } from '@bolusi/i18n';
import { TextButton, TextInput, border, color, numeric, space, type, Text, Rows } from '@bolusi/ui';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { MAX_UNIT_COST } from '../../inventory/constants.js';
import { useInventoryRuntime } from '../../inventory/runtime.js';
import { useActionRunner } from '../../screen-kit/index.js';
import {
  FlowScreen,
  QueryView,
  Section,
  type ScreenChrome,
} from '../../screen-kit/screens/views.js';
import { acceptsRupiahText, parseRupiah, rupiahFieldText } from '../../shared/rupiah.js';
import { tp } from '../i18n.js';
import { pricedTotal } from '../order-form.js';
import type { ReceiptCostRow } from '../queries.js';
import { usePurchasingQuery } from '../runtime.js';

export interface OrderCostsProps {
  readonly orderId: string;
  readonly onPrice: (line: ReceiptCostRow) => void;
  readonly onBack: () => void;
  readonly testID: string;
}

export function OrderCosts({
  orderId,
  onPrice,
  onBack,
  testID,
}: OrderCostsProps): React.JSX.Element {
  const [reloadNonce, setReloadNonce] = useState(0);
  const query = usePurchasingQuery(
    async (rt) => (await rt.query('orderCosts', { orderId })).rows,
    `orderCosts:${orderId}:${String(reloadNonce)}`,
  );
  return (
    <Section title={tp('purchasing.order.costs')} testID={`${testID}.costs`}>
      <QueryView
        query={query}
        onBack={onBack}
        onRetry={() => setReloadNonce((n) => n + 1)}
        testID={`${testID}.costs`}
      >
        {(rows) => <CostLines rows={rows} onPrice={onPrice} testID={testID} />}
      </QueryView>
    </Section>
  );
}

function CostLines({
  rows,
  onPrice,
  testID,
}: {
  readonly rows: readonly ReceiptCostRow[];
  readonly onPrice: (line: ReceiptCostRow) => void;
  readonly testID: string;
}): React.JSX.Element {
  const total = pricedTotal(rows);
  const unpriced = rows.filter((row) => row.unitCost === null).length;
  return (
    <View>
      <Rows>
        {rows.map((row) => {
          const priced = row.unitCost !== null;
          return (
            <Pressable
              key={row.movementId}
              onPress={() => onPrice(row)}
              accessibilityRole="button"
              accessibilityLabel={`${tp(priced ? 'purchasing.action.fixPrice' : 'purchasing.action.fillPrice')}: ${row.name}`}
              style={styles.line}
              testID={`${testID}.cost.${row.movementId}`}
            >
              <View style={styles.lineText}>
                <Text style={styles.lineName}>{row.name}</Text>
                <Text style={styles.meta}>
                  {priced
                    ? tp('purchasing.order.costLine', {
                        qty: row.qty,
                        price: formatMoney(row.unitCost!),
                      })
                    : tp('purchasing.order.qty', { qty: row.qty })}
                </Text>
              </View>
              {priced ? (
                <Text style={styles.amount}>{formatMoney(row.qty * row.unitCost!)}</Text>
              ) : (
                <TextButton
                  label={tp('purchasing.action.fillPrice')}
                  onPress={() => onPrice(row)}
                  testID={`${testID}.cost.${row.movementId}.fill`}
                />
              )}
            </Pressable>
          );
        })}
      </Rows>
      {total === null ? null : (
        <View style={styles.total} testID={`${testID}.costTotal`}>
          <Text style={styles.totalLabel}>{tp('purchasing.order.costTotal')}</Text>
          <Text style={styles.totalAmount}>{formatMoney(total)}</Text>
        </View>
      )}
      {unpriced === 0 ? null : (
        <Text style={styles.unpriced} testID={`${testID}.costUnpriced`}>
          {tp('purchasing.order.costUnpriced', { count: unpriced })}
        </Text>
      )}
    </View>
  );
}

export interface PriceStepProps {
  readonly chrome: ScreenChrome;
  readonly line: ReceiptCostRow;
  readonly onDone: () => void;
  readonly onCancel: () => void;
  readonly testID?: string | undefined;
}

/** Fill in, or fix, what a piece of one delivered part cost. */
export function PriceStep({
  chrome,
  line,
  onDone,
  onCancel,
  testID = 'purchasing.price',
}: PriceStepProps): React.JSX.Element {
  const inventory = useInventoryRuntime();
  const runner = useActionRunner();
  const [digits, setDigits] = useState(line.unitCost === null ? '' : String(line.unitCost));
  const unitCost = parseRupiah(digits, MAX_UNIT_COST);

  const save = (): void => {
    if (unitCost === null) return;
    void runner
      .run(() => inventory.run('priceStock', { movementId: line.movementId, unitCost }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tp('purchasing.price.title')}
      onBack={onCancel}
      primaryLabel={tp('purchasing.price.save')}
      onPrimary={save}
      primaryDisabled={unitCost === null}
      primaryHint={tp('purchasing.price.empty')}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Text style={styles.stepName}>{line.name}</Text>
      <Text style={styles.meta}>{tp('purchasing.order.qty', { qty: line.qty })}</Text>
      <View style={styles.field}>
        <TextInput
          label={tp('purchasing.price.field')}
          value={rupiahFieldText(digits, MAX_UNIT_COST)}
          onChangeText={(next) => {
            if (!acceptsRupiahText(next, MAX_UNIT_COST)) return;
            setDigits(next.replace(/\D/g, ''));
          }}
          keyboardType="number-pad"
          selectTextOnFocus
          testID={`${testID}.amount`}
        />
      </View>
      {unitCost !== null && line.qty > 1 ? (
        <View style={styles.total}>
          <Text style={styles.totalLabel}>{tp('purchasing.order.costTotal')}</Text>
          <Text style={styles.totalAmount} testID={`${testID}.total`}>
            {formatMoney(unitCost * line.qty)}
          </Text>
        </View>
      ) : null}
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  line: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingVertical: space.md,
  },
  lineText: { flex: 1, gap: space.xs },
  lineName: { ...type.body, color: color.text },
  meta: { ...type.bodySm, color: color.textMuted, ...numeric },
  amount: {
    ...type.bodySm,
    fontWeight: '600',
    color: color.text,
    ...numeric,
    flexShrink: 0,
  },
  total: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: space.md,
    paddingTop: space.md,
    marginTop: space.sm,
    borderTopWidth: border.hairline,
    borderTopColor: color.border,
  },
  totalLabel: { ...type.bodyBold, color: color.text },
  totalAmount: {
    ...type.bodyBold,
    color: color.text,
    ...numeric,
    flexShrink: 0,
  },
  unpriced: { ...type.bodySm, color: color.warning, marginTop: space.sm },
  stepName: { ...type.bodyBold, color: color.text },
  field: { marginTop: space.xl },
});
