/**
 * OrderForm — a new order, or a draft being finished: the supplier, the parts and how many of each,
 * and a note for the supplier. "Pesan" places it at once; "Simpan draf" keeps it to finish later.
 * The draft is held by the surface, so picking a part or adding a supplier and coming back keeps it.
 */
import { formatPhone, keepNumbersWhole } from '@bolusi/i18n';
import {
  ListRow,
  QuantityStepper,
  TextButton,
  TextInput,
  border,
  color,
  space,
  type,
  Text,
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

const styles = StyleSheet.create({
  noteField: { marginTop: space.xl },
  muted: { ...type.bodySm, color: color.textMuted },
  bleed: { marginHorizontal: -space.lg },
  line: {
    paddingVertical: space.md,
    gap: space.sm,
    borderBottomWidth: border.hairline,
    borderBottomColor: color.border,
  },
  lineTop: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  lineName: { ...type.bodyBold, color: color.text, flex: 1 },
});
