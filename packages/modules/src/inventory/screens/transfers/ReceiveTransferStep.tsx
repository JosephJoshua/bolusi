/**
 * ReceiveTransferStep — what arrived from another store: each part opens at what is still to come,
 * and the person sets what actually came. Saving adds it to this store's stock in one go; what did
 * not come stays "Belum sampai" on the transfer.
 */
import { QuantityStepper, TextInput, border, color, space, type, Text } from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useActionRunner } from '../../../screen-kit/index.js';
import { FlowScreen, type ScreenChrome } from '../../../screen-kit/screens/views.js';
import { ti } from '../../i18n.js';
import { useInventoryRuntime } from '../../runtime.js';
import {
  countTotal,
  receivableLines,
  receiveInput,
  receiveStart,
  stillToCome,
} from '../../transfers/form.js';
import { MAX_TRANSFER_NOTE } from '../../transfers/operations.js';
import type { TransferDetailRow } from '../../transfers/queries.js';

export interface ReceiveTransferStepProps {
  readonly chrome: ScreenChrome;
  readonly transfer: TransferDetailRow;
  readonly onDone: () => void;
  readonly onCancel: () => void;
  readonly testID?: string | undefined;
}

export function ReceiveTransferStep({
  chrome,
  transfer,
  onDone,
  onCancel,
  testID = 'inventory.receiveTransfer',
}: ReceiveTransferStepProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const runner = useActionRunner();
  const [counts, setCounts] = useState(() => receiveStart(transfer));
  const [note, setNote] = useState('');

  const save = (): void => {
    void runner
      .run(() => runtime.run('receiveTransfer', receiveInput(transfer, counts, note)))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={ti('inventory.transfer.receive.title')}
      onBack={onCancel}
      primaryLabel={ti('inventory.transfer.receive.save')}
      onPrimary={save}
      primaryDisabled={countTotal(counts) === 0}
      primaryHint={ti('inventory.transfer.receive.nothing')}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Text style={styles.hint}>{ti('inventory.transfer.receive.hint')}</Text>
      {receivableLines(transfer).map((line) => {
        const toCome = stillToCome(line);
        const count = counts[line.itemId] ?? 0;
        return (
          <View key={line.itemId} style={styles.line} testID={`${testID}.line.${line.itemId}`}>
            <Text style={styles.name}>{line.name}</Text>
            <QuantityStepper
              label={ti('inventory.transfer.receive.arrived')}
              value={count}
              onChange={(qty) => setCounts((now) => ({ ...now, [line.itemId]: qty }))}
              min={0}
              max={toCome}
              decreaseLabel={ti('inventory.stepper.decrease')}
              increaseLabel={ti('inventory.stepper.increase')}
              caption={
                count < toCome
                  ? ti('inventory.transfer.detail.missing', { count: toCome - count })
                  : undefined
              }
              testID={`${testID}.line.${line.itemId}.qty`}
            />
          </View>
        );
      })}
      <View style={styles.noteField}>
        <TextInput
          label={ti('inventory.transfer.receive.note')}
          value={note}
          onChangeText={setNote}
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
  hint: { ...type.bodySm, color: color.textMuted, marginBottom: space.sm },
  line: {
    paddingVertical: space.md,
    gap: space.sm,
    borderBottomWidth: border.hairline,
    borderBottomColor: color.border,
  },
  name: { ...type.bodyBold, color: color.text },
});
