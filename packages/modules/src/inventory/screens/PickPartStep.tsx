/**
 * PickPartStep — find a part on the business's list (by name, code or scan) to add to an order or a
 * transfer. A part already picked says so, so a second tap reads as "one more".
 */
import { t } from '@bolusi/i18n';
import {
  SearchField,
  TextButton,
  color,
  radius,
  space,
  touch,
  type,
  Text,
  numeric,
} from '@bolusi/ui';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useSettledValue } from '../../screen-kit/index.js';
import { FlowScreen, QueryView, type ScreenChrome } from '../../screen-kit/screens/views.js';
import { ti } from '../i18n.js';
import { stockText } from '../labels.js';
import type { ItemRow } from '../queries.js';
import { useInventoryQuery, useInventoryRuntime } from '../runtime.js';
import { PICK_LIMIT } from '../take-part.js';

export interface PickPartStepProps {
  readonly chrome: ScreenChrome;
  /** Parts already picked, marked so a second tap reads as "one more". */
  readonly picked: ReadonlySet<string>;
  /** The step's title ("Pilih sparepart"). */
  readonly title: string;
  readonly onPick: (item: ItemRow) => void;
  readonly onCancel: () => void;
  readonly testID?: string | undefined;
}

export function PickPartStep({
  chrome,
  picked,
  title,
  onPick,
  onCancel,
  testID = 'inventory.pick',
}: PickPartStepProps): React.JSX.Element {
  const inventory = useInventoryRuntime();
  const [text, setText] = useState('');
  const [reloadNonce, setReloadNonce] = useState(0);
  const typed = text.trim();
  const settled = useSettledValue(typed);
  const searchText = typed === '' ? '' : settled;
  const query = useInventoryQuery(
    async (rt) =>
      (await rt.query('listItems', { text: searchText, filter: 'active', limit: PICK_LIMIT })).rows,
    `pick:${searchText}:${String(reloadNonce)}`,
  );

  /** A scanned code adds its part when it names exactly one; otherwise it is searched for. */
  const scan = async (): Promise<void> => {
    const code = (await inventory.scanCode?.())?.trim() ?? '';
    if (code === '') return;
    const found = await inventory
      .query('findByCode', { code })
      .then((page) => page.rows)
      .catch(() => []);
    const only = found.length === 1 ? found[0] : undefined;
    if (only !== undefined && !only.archived) onPick(only);
    else setText(code);
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={title}
      onBack={onCancel}
      busy={false}
      errorCode={null}
      onClearError={() => undefined}
      testID={testID}
    >
      <SearchField
        placeholder={ti('inventory.pick.searchHint')}
        accessibilityLabel={t('core.action.search')}
        clearLabel={ti('inventory.pick.clear')}
        value={text}
        onChangeText={setText}
        testID={`${testID}.search`}
      />
      {inventory.scanCode === undefined ? null : (
        <View style={styles.scan}>
          <TextButton
            label={ti('inventory.pick.scan')}
            icon="scan"
            onPress={() => void scan()}
            testID={`${testID}.scan`}
          />
        </View>
      )}
      <QueryView
        query={query}
        onBack={onCancel}
        onRetry={() => setReloadNonce((n) => n + 1)}
        testID={testID}
      >
        {(rows) =>
          rows.length === 0 ? (
            <Text style={[styles.muted, styles.empty]}>
              {searchText === '' ? ti('inventory.pick.empty') : ti('inventory.pick.noMatches')}
            </Text>
          ) : (
            <View style={styles.choices}>
              {rows.map((row) => (
                <Pressable
                  key={row.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${row.name}, ${ti('inventory.pick.stock', { count: stockText(row.onHand) })}`}
                  onPress={() => onPick(row)}
                  style={({ pressed }) => [styles.choice, pressed ? styles.pressed : null]}
                  testID={`${testID}.choice.${row.id}`}
                >
                  <View style={styles.choiceText}>
                    <Text style={styles.choiceName}>{row.name}</Text>
                    {picked.has(row.id) ? (
                      <Text style={styles.muted}>{ti('inventory.pick.onList')}</Text>
                    ) : row.code === null ? null : (
                      <Text style={styles.muted}>{row.code}</Text>
                    )}
                  </View>
                  <Text style={[styles.stock, row.onHand < 0 ? styles.stockOut : null]}>
                    {ti('inventory.pick.stock', { count: stockText(row.onHand) })}
                  </Text>
                </Pressable>
              ))}
            </View>
          )
        }
      </QueryView>
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  muted: { ...type.bodySm, color: color.textMuted },
  empty: { marginTop: space.lg },
  scan: { flexDirection: 'row', marginTop: space.xs, marginLeft: -space.sm },
  choices: { marginTop: space.md },
  choice: {
    minHeight: touch.rowMin,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    marginHorizontal: -space.md,
    borderRadius: radius.sm,
  },
  pressed: { backgroundColor: color.surfaceAlt },
  choiceText: { flex: 1 },
  choiceName: { ...type.bodySm, fontWeight: '600', color: color.text },
  stock: { ...type.bodySm, color: color.textMuted, ...numeric },
  stockOut: { color: color.danger },
});
