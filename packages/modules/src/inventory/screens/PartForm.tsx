/**
 * PartForm — add a part to the business's list, or edit one. A name is all it needs; the code and
 * the phones it fits help the search find it. Adding asks how many are on the shelf now, so a new
 * part arrives with its stock in one go.
 */
import { QuantityStepper, TextInput, space } from '@bolusi/ui';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useActionRunner, type DiscardGuard } from '../../screen-kit/index.js';
import { useDiscardConfirm } from '../../screen-kit/screens/discard.js';
import { FlowScreen, type ScreenChrome } from '../../screen-kit/screens/views.js';
import { INVENTORY_PERMISSION, MAX_COUNTED_QTY } from '../constants.js';
import { ti } from '../i18n.js';
import { MAX_PART_CODE, MAX_PART_NAME } from '../operations.js';
import type { PartDetailRow, PartFitRow } from '../queries.js';
import { useInventoryRuntime } from '../runtime.js';
import { ModelsField } from './ModelsField.js';

export interface PartFormProps {
  readonly chrome: ScreenChrome;
  /** The part being edited; absent to add one. */
  readonly part?: PartDetailRow | undefined;
  readonly onDone: (partId: string) => void;
  readonly onCancel: () => void;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID?: string | undefined;
}

export function PartForm({
  chrome,
  part,
  onDone,
  onCancel,
  onRegisterDiscardGuard,
  testID = 'inventory.form',
}: PartFormProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const runner = useActionRunner();
  const adding = part === undefined;
  const canCount = adding && runtime.hasPermission(INVENTORY_PERMISSION.count);
  const [name, setName] = useState(part?.name ?? '');
  const [code, setCode] = useState(part?.code ?? '');
  const [fits, setFits] = useState<readonly PartFitRow[]>(part?.models ?? []);
  // What the phones were when the form (re)started, so kept phones alone are nothing to discard.
  const [baseFits, setBaseFits] = useState<readonly PartFitRow[]>(part?.models ?? []);
  const [stock, setStock] = useState(0);
  const [tried, setTried] = useState(false);
  const dirty =
    name !== (part?.name ?? '') || code !== (part?.code ?? '') || fits !== baseFits || stock !== 0;
  const discard = useDiscardConfirm({
    dirty,
    copy: {
      title: ti('inventory.discard.title'),
      message: ti('inventory.discard.message'),
      confirm: ti('inventory.discard.confirm'),
      keep: ti('inventory.discard.keep'),
    },
    onRegisterDiscardGuard,
    testID,
  });
  const nameMissing = name.trim() === '';
  const addedRef = useRef<string | null>(null);

  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  /** Save; with `another`, stay on a fresh form that keeps the phones it fits, for the next part. */
  const save = (another = false): void => {
    setTried(true);
    setSavedNotice(null);
    if (nameMissing) return;
    const details = { name, code: code === '' ? null : code, fits: [...fits] };
    void runner
      .run(async () => {
        if (part !== undefined) {
          return runtime.run('editPart', { partId: part.id, archived: part.archived, ...details });
        }
        // Kept, so a retry after the count failed saves the count, not a second copy of the part.
        addedRef.current ??= (await runtime.run('addPart', details)).partId;
        const partId = addedRef.current;
        if (stock > 0) await runtime.run('countStock', { counts: [{ partId, counted: stock }] });
        return { partId };
      })
      .then((result) => {
        if (result === undefined) return;
        if (!another) {
          onDone(result.partId);
          return;
        }
        // Parts often come in a run for one phone (its LCD, battery, connector): the phones stay.
        addedRef.current = null;
        setSavedNotice(ti('inventory.form.savedAnother', { name: name.trim() }));
        setName('');
        setCode('');
        setStock(0);
        setTried(false);
        setBaseFits(fits);
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={ti(adding ? 'inventory.form.addTitle' : 'inventory.form.editTitle')}
      onBack={() => discard.requestLeave(onCancel)}
      primaryLabel={ti('inventory.action.save')}
      onPrimary={() => save()}
      secondary={
        adding
          ? {
              label: ti('inventory.form.addAnother'),
              onPress: () => save(true),
              disabled: runner.busy,
              testID: `${testID}.another`,
            }
          : undefined
      }
      notice={savedNotice}
      onClearNotice={() => setSavedNotice(null)}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      overlay={discard.overlay}
      testID={testID}
    >
      <View style={styles.fields}>
        <TextInput
          label={ti('inventory.form.name')}
          placeholder={ti('inventory.form.namePlaceholder')}
          value={name}
          onChangeText={setName}
          maxLength={MAX_PART_NAME}
          autoCorrect={false}
          errorMessage={tried && nameMissing ? ti('inventory.form.nameRequired') : undefined}
          testID={`${testID}.name`}
        />
        <TextInput
          label={ti('inventory.form.code')}
          value={code}
          onChangeText={setCode}
          maxLength={MAX_PART_CODE}
          autoCorrect={false}
          autoCapitalize="characters"
          testID={`${testID}.code`}
        />
        <ModelsField value={fits} onChange={setFits} testID={`${testID}.fits`} />
        {canCount ? (
          <QuantityStepper
            label={ti('inventory.form.stock')}
            value={stock}
            onChange={setStock}
            max={MAX_COUNTED_QTY}
            decreaseLabel={ti('inventory.stepper.decrease')}
            increaseLabel={ti('inventory.stepper.increase')}
            testID={`${testID}.stock`}
          />
        ) : null}
      </View>
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  fields: { gap: space.md },
});
