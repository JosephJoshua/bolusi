/**
 * OrderForm — a new order, or a draft being finished: the supplier, the parts and how many of each,
 * and a note for the supplier. "Pesan" places it at once; "Simpan draf" keeps it to finish later.
 * The draft is held by the surface, so picking a part or adding a supplier and coming back keeps it.
 *
 * PickPartStep — find a part on the business's list (by name, code or scan) to add to the order.
 */
import { formatPhone, t } from '@bolusi/i18n';
import {
  ListRow,
  QuantityStepper,
  SearchField,
  TextButton,
  TextInput,
  border,
  color,
  radius,
  space,
  touch,
  type,
  Text,
} from '@bolusi/ui';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { stockText } from '../../inventory/labels.js';
import type { ItemRow } from '../../inventory/queries.js';
import { useInventoryQuery, useInventoryRuntime } from '../../inventory/runtime.js';
import { useActionRunner, useSettledValue, type DiscardGuard } from '../../screen-kit/index.js';
import { useDiscardConfirm } from '../../screen-kit/screens/discard.js';
import {
  FlowScreen,
  QueryView,
  Section,
  type ScreenChrome,
} from '../../screen-kit/screens/views.js';
import { MAX_LINE_QTY, MAX_PURCHASING_NOTE } from '../constants.js';
import { tp } from '../i18n.js';
import { canSave, orderInput, removeLine, setQty, type OrderDraft } from '../order-form.js';
import { usePurchasingQuery, usePurchasingRuntime } from '../runtime.js';

export interface OrderFormProps {
  readonly chrome: ScreenChrome;
  /** The draft being changed; absent for a new order. */
  readonly orderId?: string | undefined;
  readonly draft: OrderDraft;
  readonly onChange: (draft: OrderDraft) => void;
  readonly onPickPart: () => void;
  readonly onAddSupplier: () => void;
  readonly onDone: (orderId: string, placed: boolean) => void;
  readonly onCancel: () => void;
  /** Something is filled in that a back press would lose. */
  readonly dirty: boolean;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID?: string | undefined;
}

export function OrderForm({
  chrome,
  orderId,
  draft,
  onChange,
  onPickPart,
  onAddSupplier,
  onDone,
  onCancel,
  dirty,
  onRegisterDiscardGuard,
  testID = 'purchasing.form',
}: OrderFormProps): React.JSX.Element {
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
    `suppliers:${String(reloadNonce)}`,
  );

  const save = (place: boolean): void => {
    void runner
      .run(async () =>
        orderId === undefined
          ? (await runtime.run('draftOrder', orderInput(draft, place))).orderId
          : (await runtime.run('editOrder', { orderId, ...orderInput(draft, place) })).orderId,
      )
      .then((saved) => {
        if (saved !== undefined) onDone(saved, place);
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tp(orderId === undefined ? 'purchasing.form.newTitle' : 'purchasing.form.editTitle')}
      onBack={() => discard.requestLeave(onCancel)}
      overlay={discard.overlay}
      primaryLabel={tp('purchasing.action.place')}
      onPrimary={() => save(true)}
      primaryDisabled={!canSave(draft)}
      primaryHint={tp('purchasing.form.pickFirst')}
      secondary={{
        label: tp('purchasing.action.saveDraft'),
        onPress: () => save(false),
        disabled: !canSave(draft),
        testID: `${testID}.saveDraft`,
      }}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Section
        title={tp('purchasing.form.supplier')}
        first
        action={
          <TextButton
            label={tp('purchasing.supplier.add')}
            onPress={onAddSupplier}
            testID={`${testID}.addSupplier`}
          />
        }
        testID={`${testID}.supplier`}
      >
        <QueryView
          query={suppliers}
          onBack={onCancel}
          onRetry={() => setReloadNonce((n) => n + 1)}
          testID={`${testID}.suppliers`}
        >
          {(rows) =>
            rows.length === 0 ? (
              <Text style={styles.muted}>{tp('purchasing.form.noSuppliers')}</Text>
            ) : (
              <View style={styles.bleed}>
                {rows.map((row) => (
                  <ListRow
                    key={row.id}
                    primaryText={row.name}
                    secondaryText={row.phone === null ? undefined : formatPhone(row.phone)}
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

      <Section
        title={tp('purchasing.order.lines')}
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
          draft.lines.map((line) => (
            <View key={line.itemId} style={styles.line} testID={`${testID}.line.${line.itemId}`}>
              <View style={styles.lineTop}>
                <Text style={styles.lineName}>{line.name}</Text>
                <TextButton
                  label={tp('purchasing.form.remove')}
                  accessibilityLabel={`${tp('purchasing.form.remove')} ${line.name}`}
                  tone="danger"
                  onPress={() => onChange(removeLine(draft, line.itemId))}
                  testID={`${testID}.line.${line.itemId}.remove`}
                />
              </View>
              <QuantityStepper
                label={tp('purchasing.form.qty')}
                value={line.qty}
                onChange={(qty) => onChange(setQty(draft, line.itemId, qty))}
                min={1}
                max={MAX_LINE_QTY}
                decreaseLabel={tp('purchasing.form.decrease')}
                increaseLabel={tp('purchasing.form.increase')}
                testID={`${testID}.line.${line.itemId}.qty`}
              />
            </View>
          ))
        )}
      </Section>

      <View style={styles.noteField}>
        <TextInput
          label={tp('purchasing.form.note')}
          value={draft.note}
          onChangeText={(note) => onChange({ ...draft, note })}
          multiline
          maxLength={MAX_PURCHASING_NOTE}
          testID={`${testID}.note`}
        />
      </View>
    </FlowScreen>
  );
}

export interface PickPartStepProps {
  readonly chrome: ScreenChrome;
  /** Parts already on the order, marked so a second tap reads as "one more". */
  readonly onOrder: ReadonlySet<string>;
  readonly onPick: (item: ItemRow) => void;
  readonly onCancel: () => void;
  readonly testID?: string | undefined;
}

const PICK_LIMIT = 30;

export function PickPartStep({
  chrome,
  onOrder,
  onPick,
  onCancel,
  testID = 'purchasing.pick',
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
    `buyPick:${searchText}:${String(reloadNonce)}`,
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
      title={tp('purchasing.pick.title')}
      onBack={onCancel}
      busy={false}
      errorCode={null}
      onClearError={() => undefined}
      testID={testID}
    >
      <SearchField
        placeholder={tp('purchasing.pick.searchHint')}
        accessibilityLabel={t('core.action.search')}
        clearLabel={tp('purchasing.pick.clear')}
        value={text}
        onChangeText={setText}
        testID={`${testID}.search`}
      />
      {inventory.scanCode === undefined ? null : (
        <View style={styles.scan}>
          <TextButton
            label={tp('purchasing.pick.scan')}
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
              {searchText === '' ? tp('purchasing.pick.empty') : tp('purchasing.pick.noMatches')}
            </Text>
          ) : (
            <View style={styles.choices}>
              {rows.map((row) => (
                <Pressable
                  key={row.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${row.name}, ${tp('purchasing.pick.stock', { count: stockText(row.onHand) })}`}
                  onPress={() => onPick(row)}
                  style={({ pressed }) => [styles.choice, pressed ? styles.pressed : null]}
                  testID={`${testID}.choice.${row.id}`}
                >
                  <View style={styles.choiceText}>
                    <Text style={styles.choiceName}>{row.name}</Text>
                    {onOrder.has(row.id) ? (
                      <Text style={styles.muted}>{tp('purchasing.pick.onOrder')}</Text>
                    ) : row.code === null ? null : (
                      <Text style={styles.muted}>{row.code}</Text>
                    )}
                  </View>
                  <Text style={[styles.stock, row.onHand < 0 ? styles.stockOut : null]}>
                    {tp('purchasing.pick.stock', { count: stockText(row.onHand) })}
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
  noteField: { marginTop: space.xl },
  muted: { ...type.bodySm, color: color.textMuted },
  empty: { marginTop: space.lg },
  bleed: { marginHorizontal: -space.lg },
  line: {
    paddingVertical: space.md,
    gap: space.sm,
    borderBottomWidth: border.hairline,
    borderBottomColor: color.border,
  },
  lineTop: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  lineName: { ...type.bodyBold, color: color.text, flex: 1 },
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
  stock: { ...type.bodySm, color: color.textMuted, fontVariant: ['tabular-nums'] },
  stockOut: { color: color.danger },
});
