/**
 * PartCost — what a part costs this store, for people who may see buy prices ("Lihat harga
 * beli"): the average cost per piece and what the latest deliveries cost. Read apart from the
 * part, so on a store device holding no costs the part still opens and only this section says it
 * needs internet. Never "Rp 0" for a price nobody has typed.
 */
import { formatDate, formatMoney, keepCodeWhole } from '@bolusi/i18n';
import { border, color, space, type, Text } from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { QueryView, Section } from '../../screen-kit/screens/views.js';
import { ti } from '../i18n.js';
import type { ItemCostRow } from '../queries.js';
import { useInventoryQuery } from '../runtime.js';

/** How many of the latest deliveries the section lists. */
const RECEIPTS_SHOWN = 5;

export function PartCost({
  itemId,
  onBack,
  testID,
}: {
  readonly itemId: string;
  readonly onBack: () => void;
  readonly testID: string;
}): React.JSX.Element {
  const [reloadNonce, setReloadNonce] = useState(0);
  const query = useInventoryQuery(
    async (rt) => (await rt.query('itemCost', { itemId })).rows[0],
    `itemCost:${itemId}:${String(reloadNonce)}`,
  );
  return (
    <Section title={ti('inventory.cost.title')} testID={`${testID}.cost`}>
      <QueryView
        query={query}
        onBack={onBack}
        onRetry={() => setReloadNonce((n) => n + 1)}
        testID={`${testID}.cost`}
      >
        {(cost) => (cost === undefined ? null : <CostBody cost={cost} testID={testID} />)}
      </QueryView>
    </Section>
  );
}

function CostBody({
  cost,
  testID,
}: {
  readonly cost: ItemCostRow;
  readonly testID: string;
}): React.JSX.Element {
  return (
    <View>
      <Text style={styles.label}>{ti('inventory.cost.average')}</Text>
      <Text
        style={cost.average === null ? styles.none : styles.average}
        testID={`${testID}.cost.average`}
      >
        {cost.average === null
          ? ti('inventory.cost.noAverage')
          : ti('inventory.cost.perPiece', { amount: formatMoney(cost.average) })}
      </Text>
      {cost.unpriced === 0 ? null : (
        <Text style={styles.unpriced} testID={`${testID}.cost.unpriced`}>
          {ti('inventory.cost.unpriced', { count: cost.unpriced })}
        </Text>
      )}
      {cost.receipts.length === 0 ? null : (
        <View style={styles.receipts}>
          {cost.receipts.slice(0, RECEIPTS_SHOWN).map((receipt) => (
            <View
              key={receipt.movementId}
              style={styles.row}
              testID={`${testID}.cost.${receipt.movementId}`}
            >
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>
                  {receipt.label === null
                    ? ti('inventory.cost.receiptNoLabel', { qty: receipt.qty })
                    : ti('inventory.cost.receipt', {
                        qty: receipt.qty,
                        label: keepCodeWhole(receipt.label),
                      })}
                </Text>
                <Text style={styles.meta}>{formatDate(receipt.at)}</Text>
              </View>
              <Text style={receipt.unitCost === null ? styles.missing : styles.price}>
                {receipt.unitCost === null
                  ? ti('inventory.cost.missing')
                  : ti('inventory.cost.perPiece', { amount: formatMoney(receipt.unitCost) })}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { ...type.caption, color: color.textMuted },
  average: {
    ...type.heading,
    color: color.text,
    fontVariant: ['tabular-nums'],
    marginTop: space.xs,
  },
  none: { ...type.body, color: color.textMuted, marginTop: space.xs },
  unpriced: { ...type.bodySm, color: color.warning, marginTop: space.sm },
  receipts: { marginTop: space.md },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingVertical: space.sm,
    borderTopWidth: border.hairline,
    borderTopColor: color.border,
  },
  rowText: { flex: 1, gap: space.xs },
  rowTitle: { ...type.bodySm, color: color.text },
  meta: { ...type.caption, color: color.textMuted },
  price: {
    ...type.bodySm,
    fontWeight: '600',
    color: color.text,
    fontVariant: ['tabular-nums'],
    flexShrink: 0,
  },
  missing: { ...type.bodySm, color: color.warning, flexShrink: 0 },
});
