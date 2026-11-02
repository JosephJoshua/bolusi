/**
 * PartForm — add an item to the business's list, or edit one. Pick its category and fill in the
 * category's fields; the name builds itself from them by the category's format, so a long list
 * entered by many people reads one way (owner decision, 2026-10-28). A name can still be typed for
 * an odd item, and an item can go without a category. The code, barcode and tags help find it.
 * Adding asks how many are on the shelf now, so a new item arrives with its stock in one go, and
 * "Tambah lagi" keeps the category, fields and phones for the next item of a run.
 */
import {
  ChipRow,
  ChoiceChips,
  QuantityStepper,
  TextButton,
  TextInput,
  ToggleChip,
  color,
  radius,
  space,
  type,
  Text,
} from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { DiscardGuard } from '../../screen-kit/index.js';
import { useDiscardConfirm } from '../../screen-kit/screens/discard.js';
import { FlowScreen, type ScreenChrome } from '../../screen-kit/screens/views.js';
import { MAX_FIELD_VALUE, type CategoryField } from '../categories.js';
import { MAX_COUNTED_QTY, TAG_FACET } from '../constants.js';
import { ti } from '../i18n.js';
import { MAX_BARCODE, MAX_PART_CODE, MAX_PART_NAME } from '../operations.js';
import { useItemForm } from '../item-form.js';
import type { ItemDetailRow, ItemFitRow } from '../queries.js';
import { useInventoryRuntime } from '../runtime.js';
import { ModelsField } from './ModelsField.js';

export interface PartFormProps {
  readonly chrome: ScreenChrome;
  /** The item being edited; absent to add one. */
  readonly part?: ItemDetailRow | undefined;
  /** For a new item: the category the list was showing, so it starts there. */
  readonly categoryId?: string | null | undefined;
  readonly onDone: (itemId: string) => void;
  readonly onCancel: () => void;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID?: string | undefined;
}

export function PartForm({
  chrome,
  part,
  categoryId,
  onDone,
  onCancel,
  onRegisterDiscardGuard,
  testID = 'inventory.form',
}: PartFormProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const form = useItemForm({ part, categoryId });
  const { draft, set, runner, category, categories, fields, autoName, builtName, nameMissing } =
    form;
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const discard = useDiscardConfirm({
    dirty: form.dirty,
    copy: {
      title: ti('inventory.discard.title'),
      message: ti('inventory.discard.message'),
      confirm: ti('inventory.discard.confirm'),
      keep: ti('inventory.discard.keep'),
    },
    onRegisterDiscardGuard,
    testID,
  });

  const scan = async (): Promise<void> => {
    const code = await runtime.scanCode?.();
    if (code !== null && code !== undefined) set({ barcode: code });
  };

  const save = (another = false): void => {
    setSavedNotice(null);
    void form.save(another).then((saved) => {
      if (saved === undefined) return;
      if (another) setSavedNotice(ti('inventory.form.savedAnother', { name: saved.name }));
      else onDone(saved.itemId);
    });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={ti(form.adding ? 'inventory.form.addTitle' : 'inventory.form.editTitle')}
      onBack={() => discard.requestLeave(onCancel)}
      primaryLabel={ti('inventory.action.save')}
      onPrimary={() => save()}
      secondary={
        form.adding
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
        {categories.length === 0 ? null : (
          <View>
            <Text style={styles.label}>{ti('inventory.form.category')}</Text>
            <ChipRow testID={`${testID}.category`}>
              {categories.map((c) => (
                <ToggleChip
                  key={c.id}
                  label={c.name}
                  selected={c.id === draft.categoryId}
                  onToggle={() => form.pickCategory(c.id === draft.categoryId ? null : c.id)}
                  testID={`${testID}.category.${c.id}`}
                />
              ))}
            </ChipRow>
          </View>
        )}
        {fields.map((field) => (
          <FieldInput
            key={field.id}
            field={field}
            values={draft.values[field.id] ?? []}
            used={form.usedValues(field.id)}
            fits={draft.fits}
            onValues={(values) => set({ values: { ...draft.values, [field.id]: values } })}
            onFits={(fits) => set({ fits })}
            testID={`${testID}.field.${field.id}`}
          />
        ))}
        {category === null ? (
          <ModelsField
            value={draft.fits}
            onChange={(fits) => set({ fits })}
            testID={`${testID}.fits`}
          />
        ) : null}
        {autoName ? (
          <View testID={`${testID}.autoName`}>
            <Text style={styles.label}>{ti('inventory.form.autoName')}</Text>
            <View style={styles.nameBox}>
              <Text
                style={nameMissing ? styles.namePending : styles.name}
                testID={`${testID}.autoName.text`}
              >
                {nameMissing ? ti('inventory.form.autoNameEmpty') : builtName}
              </Text>
            </View>
            {form.tried && nameMissing ? (
              <Text style={styles.error}>{ti('inventory.form.nameRequired')}</Text>
            ) : null}
            <View style={styles.inlineAction}>
              <TextButton
                label={ti('inventory.form.editName')}
                icon="edit"
                onPress={form.editName}
                testID={`${testID}.editName`}
              />
            </View>
          </View>
        ) : (
          <View>
            <TextInput
              label={ti('inventory.form.name')}
              placeholder={ti('inventory.form.namePlaceholder')}
              value={draft.name}
              onChangeText={(text) => set({ name: text })}
              maxLength={MAX_PART_NAME}
              autoCorrect={false}
              errorMessage={
                form.tried && nameMissing ? ti('inventory.form.nameRequired') : undefined
              }
              testID={`${testID}.name`}
            />
            {category === null ? null : (
              <View style={styles.inlineAction}>
                <TextButton
                  label={ti('inventory.form.useAutoName')}
                  onPress={() => set({ nameAuto: true })}
                  testID={`${testID}.useAutoName`}
                />
              </View>
            )}
          </View>
        )}
        <TextInput
          label={ti('inventory.form.code')}
          value={draft.code}
          onChangeText={(code) => set({ code })}
          maxLength={MAX_PART_CODE}
          autoCorrect={false}
          autoCapitalize="characters"
          testID={`${testID}.code`}
        />
        <View>
          <TextInput
            label={ti('inventory.form.barcode')}
            value={draft.barcode}
            onChangeText={(barcode) => set({ barcode })}
            maxLength={MAX_BARCODE}
            autoCorrect={false}
            autoCapitalize="none"
            testID={`${testID}.barcode`}
          />
          {runtime.scanCode === undefined ? null : (
            <View style={styles.inlineAction}>
              <TextButton
                label={ti('inventory.form.scan')}
                icon="scan"
                onPress={() => void scan()}
                testID={`${testID}.scan`}
              />
            </View>
          )}
        </View>
        <ChoiceChips
          label={ti('inventory.form.tags')}
          options={form.usedValues(TAG_FACET)}
          value={draft.tags}
          onChange={(tags) => set({ tags })}
          multiple
          addLabel={ti('inventory.form.addTag')}
          addFieldLabel={ti('inventory.form.newTag')}
          maxLength={MAX_FIELD_VALUE}
          testID={`${testID}.tags`}
        />
        {form.canCount ? (
          <QuantityStepper
            label={ti('inventory.form.stock')}
            value={form.stock}
            onChange={form.setStock}
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

/** One of the category's fields: choices for a pick, a box for text, the phone picker for phones. */
function FieldInput({
  field,
  values,
  used,
  fits,
  onValues,
  onFits,
  testID,
}: {
  readonly field: CategoryField;
  readonly values: readonly string[];
  readonly used: readonly string[];
  readonly fits: readonly ItemFitRow[];
  readonly onValues: (values: readonly string[]) => void;
  readonly onFits: (fits: readonly ItemFitRow[]) => void;
  readonly testID: string;
}): React.JSX.Element {
  switch (field.kind) {
    case 'phones':
      return <ModelsField label={field.label} value={fits} onChange={onFits} testID={testID} />;
    case 'text':
      return (
        <TextInput
          label={field.label}
          value={values[0] ?? ''}
          onChangeText={(text) => onValues(text.trim() === '' ? [] : [text])}
          maxLength={MAX_FIELD_VALUE}
          autoCorrect={false}
          testID={testID}
        />
      );
    case 'one':
    case 'many':
      return (
        <ChoiceChips
          label={field.label}
          options={[...field.options, ...used]}
          value={values}
          onChange={onValues}
          multiple={field.kind === 'many'}
          addLabel={ti('inventory.form.otherValue')}
          addFieldLabel={ti('inventory.form.newValue')}
          maxLength={MAX_FIELD_VALUE}
          testID={testID}
        />
      );
  }
}

const styles = StyleSheet.create({
  fields: { gap: space.lg },
  label: { ...type.caption, color: color.textMuted, marginBottom: space.xs },
  nameBox: {
    borderRadius: radius.sm,
    backgroundColor: color.surfaceAlt,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  name: { ...type.bodyBold, color: color.text },
  namePending: { ...type.bodySm, color: color.textMuted },
  error: { ...type.caption, color: color.danger, marginTop: space.xs },
  // Text buttons line their text up with the field's left edge, not their hit box.
  inlineAction: { flexDirection: 'row', marginTop: space.xs, marginLeft: -space.sm },
});
