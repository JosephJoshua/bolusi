/**
 * SettleStep — the sending owner closes what a transfer left open. Parts that never arrived go back
 * into this store's stock or are written off with a reason; parts the other store recorded beyond
 * what was sent are settled as arrived, and come off this store's stock.
 */
import { QuantityStepper, TextInput, border, color, space, type, Text, numeric } from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useActionRunner } from '../../../screen-kit/index.js';
import { FlowScreen, type ScreenChrome } from '../../../screen-kit/screens/views.js';
import { ti } from '../../i18n.js';
import { useInventoryRuntime } from '../../runtime.js';
import {
  settleInput,
  settleLines,
  settleMode,
  settleProblem,
  settleStart,
  type SettleCounts,
} from '../../transfers/form.js';
import { MAX_TRANSFER_NOTE } from '../../transfers/operations.js';
import type { TransferDetailRow } from '../../transfers/queries.js';

export interface SettleStepProps {
  readonly chrome: ScreenChrome;
  readonly transfer: TransferDetailRow;
  readonly onDone: () => void;
  readonly onCancel: () => void;
  readonly testID?: string | undefined;
}

export function SettleStep({
  chrome,
  transfer,
  onDone,
  onCancel,
  testID = 'inventory.settle',
}: SettleStepProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const runner = useActionRunner();
  const [counts, setCounts] = useState<SettleCounts>(() => settleStart(transfer));
  const [reason, setReason] = useState('');
  const over = settleMode(transfer) === 'over';
  const problem = settleProblem(transfer, counts, reason);
  const writesOff = Object.values(counts.lost).some((qty) => qty > 0);
  const set = (outcome: keyof SettleCounts, itemId: string, qty: number): void =>
    setCounts((now) => ({ ...now, [outcome]: { ...now[outcome], [itemId]: qty } }));

  const save = (): void => {
    void runner
      .run(() => runtime.run('settleTransfer', settleInput(transfer, counts, reason)))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={ti('inventory.transfer.settle.title')}
      onBack={onCancel}
      primaryLabel={ti('inventory.transfer.settle.save')}
      onPrimary={save}
      primaryDisabled={problem !== null}
      primaryHint={
        problem === null
          ? undefined
          : ti(
              problem === 'nothing'
                ? 'inventory.transfer.settle.nothing'
                : problem === 'tooMany'
                  ? 'inventory.transfer.settle.tooMany'
                  : 'inventory.transfer.settle.needReason',
            )
      }
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Text style={styles.hint}>
        {ti(over ? 'inventory.transfer.settle.hintOver' : 'inventory.transfer.settle.hintMissing')}
      </Text>
      {settleLines(transfer).map((line) => {
        const open = over ? -line.missing : line.missing;
        const back = counts.back[line.itemId] ?? 0;
        const lost = counts.lost[line.itemId] ?? 0;
        return (
          <View key={line.itemId} style={styles.line} testID={`${testID}.line.${line.itemId}`}>
            <View style={styles.lineTop}>
              <Text style={styles.name}>{line.name}</Text>
              <Text style={styles.open}>
                {ti(over ? 'inventory.transfer.settle.over' : 'inventory.transfer.settle.open', {
                  count: open,
                })}
              </Text>
            </View>
            {over ? (
              <QuantityStepper
                label={ti('inventory.transfer.settle.arrived')}
                value={counts.arrived[line.itemId] ?? 0}
                onChange={(qty) => set('arrived', line.itemId, qty)}
                min={0}
                max={open}
                decreaseLabel={ti('inventory.stepper.decrease')}
                increaseLabel={ti('inventory.stepper.increase')}
                testID={`${testID}.line.${line.itemId}.arrived`}
              />
            ) : (
              <>
                <QuantityStepper
                  label={ti('inventory.transfer.settle.back')}
                  value={back}
                  onChange={(qty) => set('back', line.itemId, qty)}
                  min={0}
                  max={open - lost}
                  decreaseLabel={ti('inventory.stepper.decrease')}
                  increaseLabel={ti('inventory.stepper.increase')}
                  testID={`${testID}.line.${line.itemId}.back`}
                />
                <QuantityStepper
                  label={ti('inventory.transfer.settle.lost')}
                  value={lost}
                  onChange={(qty) => set('lost', line.itemId, qty)}
                  min={0}
                  max={open - back}
                  decreaseLabel={ti('inventory.stepper.decrease')}
                  increaseLabel={ti('inventory.stepper.increase')}
                  testID={`${testID}.line.${line.itemId}.lost`}
                />
              </>
            )}
          </View>
        );
      })}
      {/* Asked for only once something is written off: the reason is for the write-off. */}
      {over || !writesOff ? null : (
        <View style={styles.noteField}>
          <TextInput
            label={ti('inventory.transfer.settle.reason')}
            value={reason}
            onChangeText={setReason}
            multiline
            maxLength={MAX_TRANSFER_NOTE}
            testID={`${testID}.reason`}
          />
        </View>
      )}
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
  lineTop: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  name: { ...type.bodyBold, color: color.text, flexShrink: 1 },
  open: { ...type.bodySm, color: color.warning, ...numeric },
});
