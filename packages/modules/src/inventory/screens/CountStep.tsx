/**
 * CountStep — what is on the shelf for one part. The number starts at what the store has recorded,
 * so a matching count is one tap, and the difference is said as it changes. Saving records the
 * count; takes another phone has not synced yet still come off once they arrive.
 */
import { QuantityStepper, TextInput, color, space, type } from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useActionRunner, type DiscardGuard } from '../../screen-kit/index.js';
import { useDiscardConfirm } from '../../screen-kit/screens/discard.js';
import { FlowScreen, type ScreenChrome } from '../../screen-kit/screens/views.js';
import { MAX_COUNTED_QTY } from '../constants.js';
import { ti } from '../i18n.js';
import { MAX_NOTE } from '../operations.js';
import type { ItemRow } from '../queries.js';
import { useInventoryRuntime } from '../runtime.js';

export interface CountStepProps {
  readonly chrome: ScreenChrome;
  readonly part: ItemRow;
  readonly onDone: () => void;
  readonly onCancel: () => void;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID?: string | undefined;
}

export function CountStep({
  chrome,
  part,
  onDone,
  onCancel,
  onRegisterDiscardGuard,
  testID = 'inventory.countStep',
}: CountStepProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const runner = useActionRunner();
  const recorded = part.onHand;
  const [counted, setCounted] = useState(Math.max(0, recorded));
  const [note, setNote] = useState('');
  const discard = useDiscardConfirm({
    dirty: counted !== Math.max(0, recorded) || note !== '',
    copy: {
      title: ti('inventory.discard.title'),
      message: ti('inventory.discard.message'),
      confirm: ti('inventory.discard.confirm'),
      keep: ti('inventory.discard.keep'),
    },
    onRegisterDiscardGuard,
    testID,
  });
  const difference = counted - recorded;

  const save = (): void => {
    void runner
      .run(() =>
        runtime.run('countStock', {
          counts: [{ itemId: part.id, counted }],
          note: note.trim() === '' ? null : note,
        }),
      )
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={ti('inventory.count.title')}
      onBack={() => discard.requestLeave(onCancel)}
      primaryLabel={ti('inventory.count.save')}
      onPrimary={save}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      overlay={discard.overlay}
      testID={testID}
    >
      <Text style={styles.name} testID={`${testID}.part`}>
        {part.name}
      </Text>
      <View style={styles.fields}>
        <QuantityStepper
          label={ti('inventory.count.counted')}
          value={counted}
          onChange={setCounted}
          max={MAX_COUNTED_QTY}
          decreaseLabel={ti('inventory.stepper.decrease')}
          increaseLabel={ti('inventory.stepper.increase')}
          caption={`${ti('inventory.count.recorded', { count: recorded })} · ${
            difference === 0
              ? ti('inventory.count.same')
              : difference > 0
                ? ti('inventory.count.more', { count: difference })
                : ti('inventory.count.less', { count: -difference })
          }`}
          testID={`${testID}.counted`}
        />
        <TextInput
          label={ti('inventory.count.note')}
          value={note}
          onChangeText={setNote}
          maxLength={MAX_NOTE}
          multiline
          testID={`${testID}.note`}
        />
      </View>
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  name: { ...type.heading, color: color.text, marginBottom: space.lg },
  fields: { gap: space.lg },
});
