/**
 * ReceiveStep — what arrived on a placed order: each part opens at what is still to come, and the
 * buyer sets what actually came, with the buy price per piece from the supplier's nota when they
 * have it (it can be filled in later). Saving adds it all to this store's stock in one go.
 */
import { QuantityStepper, TextInput, color, space, type, Text, Rows } from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { MAX_UNIT_COST } from '../../inventory/constants.js';
import { useActionRunner } from '../../screen-kit/index.js';
import { acceptsRupiahText, rupiahFieldText } from '../../shared/rupiah.js';
import { FlowScreen, type ScreenChrome } from '../../screen-kit/screens/views.js';
import { MAX_LINE_QTY, MAX_PURCHASING_NOTE } from '../constants.js';
import { tp } from '../i18n.js';
import { receiveHint, receiveInput, receiveStart, receivedTotal } from '../order-form.js';
import type { OrderDetailRow } from '../queries.js';
import { usePurchasingRuntime } from '../runtime.js';

export interface ReceiveStepProps {
  readonly chrome: ScreenChrome;
  readonly order: OrderDetailRow;
  readonly onDone: () => void;
  readonly onCancel: () => void;
  readonly testID?: string | undefined;
}

export function ReceiveStep({
  chrome,
  order,
  onDone,
  onCancel,
  testID = 'purchasing.receive',
}: ReceiveStepProps): React.JSX.Element {
  const runtime = usePurchasingRuntime();
  const runner = useActionRunner();
  const [counts, setCounts] = useState(() => receiveStart(order));
  const [note, setNote] = useState('');
  // Typed digits per part: kept apart from the count so a part set to 0 and back keeps its price.
  const [prices, setPrices] = useState<Readonly<Record<string, string>>>({});

  const save = (): void => {
    void runner
      .run(() => runtime.run('receiveOrder', receiveInput(order, counts, note, prices)))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tp('purchasing.receive.title')}
      onBack={onCancel}
      primaryLabel={tp('purchasing.receive.save')}
      onPrimary={save}
      primaryDisabled={receivedTotal(counts) === 0}
      primaryHint={tp('purchasing.receive.nothing')}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Text style={styles.hint}>{tp('purchasing.receive.hint')}</Text>
      <Rows>
        {order.lines.map((line) => (
          <View key={line.itemId} style={styles.line} testID={`${testID}.line.${line.itemId}`}>
            <Text style={styles.name}>{line.name}</Text>
            <QuantityStepper
              label={tp('purchasing.receive.arrived')}
              value={counts[line.itemId] ?? 0}
              onChange={(qty) => setCounts((now) => ({ ...now, [line.itemId]: qty }))}
              min={0}
              max={MAX_LINE_QTY}
              decreaseLabel={tp('purchasing.form.decrease')}
              increaseLabel={tp('purchasing.form.increase')}
              caption={receiveHint(line, counts[line.itemId] ?? 0)}
              testID={`${testID}.line.${line.itemId}.qty`}
            />
            {(counts[line.itemId] ?? 0) > 0 ? (
              <TextInput
                label={tp('purchasing.receive.price')}
                value={rupiahFieldText(prices[line.itemId] ?? '', MAX_UNIT_COST)}
                onChangeText={(next) => {
                  if (!acceptsRupiahText(next, MAX_UNIT_COST)) return;
                  setPrices((now) => ({ ...now, [line.itemId]: next.replace(/\D/g, '') }));
                }}
                keyboardType="number-pad"
                selectTextOnFocus
                testID={`${testID}.line.${line.itemId}.price`}
              />
            ) : null}
          </View>
        ))}
      </Rows>
      <View style={styles.noteField}>
        <TextInput
          label={tp('purchasing.receive.note')}
          value={note}
          onChangeText={setNote}
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
  hint: { ...type.bodySm, color: color.textMuted, marginBottom: space.sm },
  line: {
    paddingVertical: space.md,
    gap: space.sm,
  },
  name: { ...type.bodyBold, color: color.text },
});
