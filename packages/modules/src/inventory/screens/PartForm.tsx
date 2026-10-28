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
} from '@bolusi/ui';
import { useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useActionRunner, type DiscardGuard } from '../../screen-kit/index.js';
import { useDiscardConfirm } from '../../screen-kit/screens/discard.js';
import { FlowScreen, type ScreenChrome } from '../../screen-kit/screens/views.js';
import {
  MAX_FIELD_VALUE,
  formatItemName,
  type CategoryField,
  type FieldValues,
} from '../categories.js';
import { INVENTORY_PERMISSION, MAX_COUNTED_QTY, TAG_FACET } from '../constants.js';
import { ti } from '../i18n.js';
import { MAX_BARCODE, MAX_PART_CODE, MAX_PART_NAME } from '../operations.js';
import type { CategoryRow, FacetValueRow, ItemDetailRow, ItemFitRow } from '../queries.js';
import { useInventoryQuery, useInventoryRuntime } from '../runtime.js';
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

interface Draft {
  readonly categoryId: string | null;
  readonly values: FieldValues;
  readonly fits: readonly ItemFitRow[];
  /** True while the name is the category's format filled in. */
  readonly nameAuto: boolean;
  /** The typed name; unused while `nameAuto`. */
  readonly name: string;
  readonly code: string;
  readonly barcode: string;
  readonly tags: readonly string[];
}

function draftOf(part: ItemDetailRow | undefined, categoryId: string | null): Draft {
  return {
    categoryId: part?.categoryId ?? categoryId,
    values: part?.values ?? {},
    fits: part?.models ?? [],
    nameAuto: part?.nameAuto ?? true,
    name: part?.name ?? '',
    code: part?.code ?? '',
    barcode: part?.barcode ?? '',
    tags: part?.tags ?? [],
  };
}

export function PartForm({
  chrome,
  part,
  categoryId: startCategory = null,
  onDone,
  onCancel,
  onRegisterDiscardGuard,
  testID = 'inventory.form',
}: PartFormProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const runner = useActionRunner();
  const adding = part === undefined;
  const canCount = adding && runtime.hasPermission(INVENTORY_PERMISSION.count);
  const [draft, setDraft] = useState<Draft>(() => draftOf(part, startCategory));
  // What the form was when it (re)started, so what "Tambah lagi" keeps is nothing to discard.
  const [base, setBase] = useState<Draft>(draft);
  const [stock, setStock] = useState(0);
  const [tried, setTried] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const addedRef = useRef<{ readonly itemId: string; readonly saved: string } | null>(null);
  const set = (patch: Partial<Draft>): void => setDraft((current) => ({ ...current, ...patch }));

  // An archived category stays listed only for an item already in it.
  const categoryList = useInventoryQuery<readonly CategoryRow[]>(
    async (rt) => (await rt.query('listCategories', { includeArchived: true })).rows,
    'itemFormCategories',
  );
  // Field ids belong to their category, so its fields offer what its own items hold; tags are the
  // whole list's. Read apart from the categories so picking one never blanks the form.
  const facetList = useInventoryQuery<readonly FacetValueRow[]>(
    async (rt) => [
      ...(draft.categoryId === null
        ? []
        : (await rt.query('facetValues', { categoryId: draft.categoryId })).rows.filter(
            (row) => row.facet !== TAG_FACET,
          )),
      ...(await rt.query('facetValues', {})).rows.filter((row) => row.facet === TAG_FACET),
    ],
    `itemFormFacets:${draft.categoryId ?? ''}`,
  );
  const loaded = {
    categories: categoryList.status === 'ready' ? categoryList.data : [],
    facets: facetList.status === 'ready' ? facetList.data : [],
  };
  const categories = loaded.categories.filter(
    (category) => !category.archived || category.id === draft.categoryId,
  );
  const category = categories.find((c) => c.id === draft.categoryId) ?? null;
  const fields = category?.fields ?? [];
  const hasPhones = category === null || fields.some((field) => field.kind === 'phones');
  const autoName = category !== null && draft.nameAuto;
  const builtName = category === null ? '' : formatItemName(category, draft.values, draft.fits);
  const name = autoName ? builtName : draft.name.trim();
  const nameMissing = name === '';

  const dirty = JSON.stringify(draft) !== JSON.stringify(base) || stock !== 0;
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

  /** Values in use for a field (or the tags), beyond the ones its category lists: most used first. */
  const usedValues = (facet: string): string[] =>
    loaded.facets.filter((row) => row.facet === facet).map((row) => row.value);

  const scan = async (): Promise<void> => {
    const code = await runtime.scanCode?.();
    if (code !== null && code !== undefined) set({ barcode: code });
  };

  /** Save; with `another`, stay on a fresh form that keeps the category, fields and phones. */
  const save = (another = false): void => {
    setTried(true);
    setSavedNotice(null);
    if (nameMissing) return;
    const details = {
      name: autoName ? '' : draft.name,
      nameAuto: autoName,
      code: draft.code === '' ? null : draft.code,
      barcode: draft.barcode === '' ? null : draft.barcode,
      categoryId: draft.categoryId,
      values: Object.fromEntries(Object.entries(draft.values).map(([id, v]) => [id, [...v]])),
      tags: [...draft.tags],
      fits: hasPhones ? [...draft.fits] : [],
    };
    void runner
      .run(async () => {
        if (part !== undefined) {
          return runtime.run('editItem', { itemId: part.id, archived: part.archived, ...details });
        }
        // Kept, so a retry after the count failed saves the count, not a second copy of the item;
        // details changed before the retry go on as an edit.
        const saved = JSON.stringify(details);
        if (addedRef.current === null) {
          const { itemId } = await runtime.run('addItem', details);
          addedRef.current = { itemId, saved };
        } else if (addedRef.current.saved !== saved) {
          await runtime.run('editItem', {
            itemId: addedRef.current.itemId,
            archived: false,
            ...details,
          });
          addedRef.current = { itemId: addedRef.current.itemId, saved };
        }
        const { itemId } = addedRef.current;
        if (stock > 0) await runtime.run('countStock', { counts: [{ itemId, counted: stock }] });
        return { itemId };
      })
      .then((result) => {
        if (result === undefined) return;
        if (!another) {
          onDone(result.itemId);
          return;
        }
        // Items often come in a run (one phone's LCD, battery, connector; one LCD in three
        // qualities): the category, fields and phones stay, and the next one changes what differs.
        addedRef.current = null;
        setSavedNotice(ti('inventory.form.savedAnother', { name }));
        const next: Draft = { ...draft, name: '', code: '', barcode: '' };
        setDraft(next);
        setBase(next);
        setStock(0);
        setTried(false);
      });
  };

  const pickCategory = (id: string | null): void => {
    // Values of the old category's fields go; a typed name stays typed.
    set({ categoryId: id, values: {}, nameAuto: draft.nameAuto || draft.name.trim() === '' });
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
        {categories.length === 0 ? null : (
          <View>
            <Text style={styles.label}>{ti('inventory.form.category')}</Text>
            <ChipRow testID={`${testID}.category`}>
              {categories.map((c) => (
                <ToggleChip
                  key={c.id}
                  label={c.name}
                  selected={c.id === draft.categoryId}
                  onToggle={() => pickCategory(c.id === draft.categoryId ? null : c.id)}
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
            used={usedValues(field.id)}
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
            {tried && nameMissing ? (
              <Text style={styles.error}>{ti('inventory.form.nameRequired')}</Text>
            ) : null}
            <View style={styles.inlineAction}>
              <TextButton
                label={ti('inventory.form.editName')}
                icon="edit"
                onPress={() => set({ nameAuto: false, name: builtName })}
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
              errorMessage={tried && nameMissing ? ti('inventory.form.nameRequired') : undefined}
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
          options={usedValues(TAG_FACET)}
          value={draft.tags}
          onChange={(tags) => set({ tags })}
          multiple
          addLabel={ti('inventory.form.addTag')}
          addFieldLabel={ti('inventory.form.newTag')}
          maxLength={MAX_FIELD_VALUE}
          testID={`${testID}.tags`}
        />
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
