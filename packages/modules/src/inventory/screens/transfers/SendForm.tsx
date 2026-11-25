/**
 * SendForm — parts going to another store: the store, the parts and how many of each, and a note.
 * "Kirim" takes them out of this store's stock at once. The draft is held by the surface, so picking
 * a part and coming back keeps it.
 */
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
import { StyleSheet, View } from 'react-native';

import { useActionRunner, type DiscardGuard } from '../../../screen-kit/index.js';
import { useDiscardConfirm } from '../../../screen-kit/screens/discard.js';
import { FlowScreen, Section, type ScreenChrome } from '../../../screen-kit/screens/views.js';
import { MAX_MOVEMENT_QTY } from '../../constants.js';
import { ti } from '../../i18n.js';
import { useInventoryRuntime } from '../../runtime.js';
import { overStockHint } from '../../take-part.js';
import {
  canSend,
  removeSendLine,
  sendInput,
  setSendQty,
  type SendDraft,
} from '../../transfers/form.js';
import { MAX_TRANSFER_NOTE } from '../../transfers/operations.js';
import { useStores } from '../../transfers/stores.js';

export interface SendFormProps {
  readonly chrome: ScreenChrome;
  readonly draft: SendDraft;
  readonly onChange: (draft: SendDraft) => void;
  readonly onPickPart: () => void;
  readonly onDone: (transferId: string) => void;
  readonly onCancel: () => void;
  /** Something is filled in that a back press would lose. */
  readonly dirty: boolean;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID?: string | undefined;
}

export function SendForm({
  chrome,
  draft,
  onChange,
  onPickPart,
  onDone,
  onCancel,
  dirty,
  onRegisterDiscardGuard,
  testID = 'inventory.send',
}: SendFormProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const runner = useActionRunner();
  const stores = useStores();
  const discard = useDiscardConfirm({
    dirty,
    copy: {
      title: ti('inventory.transfer.discard.title'),
      message: ti('inventory.transfer.discard.message'),
      confirm: ti('inventory.discard.confirm'),
      keep: ti('inventory.discard.keep'),
    },
    onRegisterDiscardGuard,
    testID,
  });

  const send = (): void => {
    void runner
      .run(async () => (await runtime.run('sendTransfer', sendInput(draft))).transferId)
      .then((transferId) => {
        if (transferId !== undefined) onDone(transferId);
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={ti('inventory.transfer.form.title')}
      onBack={() => discard.requestLeave(onCancel)}
      overlay={discard.overlay}
      primaryLabel={ti('inventory.transfer.form.send')}
      onPrimary={send}
      primaryDisabled={!canSend(draft)}
      primaryHint={ti('inventory.transfer.form.pickFirst')}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Section title={ti('inventory.transfer.form.store')} first testID={`${testID}.store`}>
        {stores.length === 0 ? (
          <Text style={styles.muted}>{ti('inventory.transfer.form.noStores')}</Text>
        ) : (
          <View style={styles.bleed}>
            {stores.map((store) => (
              <ListRow
                key={store.id}
                primaryText={store.name}
                selected={draft.toStoreId === store.id}
                onPress={() => onChange({ ...draft, toStoreId: store.id })}
                testID={`${testID}.store.${store.id}`}
              />
            ))}
          </View>
        )}
      </Section>

      <Section
        title={ti('inventory.transfer.form.lines')}
        action={
          <TextButton
            label={ti('inventory.transfer.form.addPart')}
            onPress={onPickPart}
            testID={`${testID}.addPart`}
          />
        }
        testID={`${testID}.lines`}
      >
        {draft.lines.length === 0 ? (
          <Text style={styles.muted}>{ti('inventory.transfer.form.noParts')}</Text>
        ) : (
          draft.lines.map((line) => (
            <View key={line.itemId} style={styles.line} testID={`${testID}.line.${line.itemId}`}>
              <View style={styles.lineTop}>
                <Text style={styles.lineName}>{line.name}</Text>
                <TextButton
                  label={ti('inventory.transfer.form.remove')}
                  accessibilityLabel={`${ti('inventory.transfer.form.remove')} ${line.name}`}
                  tone="danger"
                  onPress={() => onChange(removeSendLine(draft, line.itemId))}
                  testID={`${testID}.line.${line.itemId}.remove`}
                />
              </View>
              <QuantityStepper
                label={ti('inventory.transfer.form.qty')}
                value={line.qty}
                onChange={(qty) => onChange(setSendQty(draft, line.itemId, qty))}
                min={1}
                max={MAX_MOVEMENT_QTY}
                decreaseLabel={ti('inventory.stepper.decrease')}
                increaseLabel={ti('inventory.stepper.increase')}
                caption={overStockHint(line, line.qty) ?? undefined}
                testID={`${testID}.line.${line.itemId}.qty`}
              />
            </View>
          ))
        )}
        {draft.lines.length === 0 ? null : (
          <Text style={[styles.muted, styles.leaves]}>
            {ti('inventory.transfer.form.stockLeaves')}
          </Text>
        )}
      </Section>

      <View style={styles.noteField}>
        <TextInput
          label={ti('inventory.transfer.form.note')}
          value={draft.note}
          onChangeText={(note) => onChange({ ...draft, note })}
          multiline
          maxLength={MAX_TRANSFER_NOTE}
          testID={`${testID}.note`}
        />
      </View>
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  noteField: { marginTop: space.xl },
  muted: { ...type.bodySm, color: color.textMuted },
  leaves: { marginTop: space.md },
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
