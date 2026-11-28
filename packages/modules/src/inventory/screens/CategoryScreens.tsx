/**
 * The business owner's categories (owner decision, 2026-10-28). Each lists the fields its items
 * fill in (LCD: the phones it fits, Kualitas, Tambahan) and a name format built from them, so a
 * long list entered by many people still reads one way, and says whether its items are spareparts
 * a servisan can take. Saving a new format renames the items it named, not the ones typed by hand.
 *
 * CategoryList shows them all; CategoryForm adds or edits one. Fields open one at a time, like the
 * intake option lists: tap to edit, drag the handle to reorder.
 */
import { t } from '@bolusi/i18n';
import {
  ActionChip,
  Chip,
  ChipRow,
  ConfirmSheet,
  EmptyState,
  ListRow,
  ReorderableList,
  SegmentedControl,
  SwitchRow,
  TextButton,
  TextInput,
  color,
  radius,
  space,
  touch,
  type,
  Text,
  ValueText,
  Rows,
} from '@bolusi/ui';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { DiscardGuard } from '../../screen-kit/index.js';
import { useDiscardConfirm } from '../../screen-kit/screens/discard.js';
import { FlowScreen, QueryView, type ScreenChrome } from '../../screen-kit/screens/views.js';
import {
  MAX_CATEGORY_NAME,
  MAX_FIELD_LABEL,
  MAX_FIELD_VALUE,
  MAX_NAME_FORMAT,
  valueKey,
  type CategoryField,
} from '../categories.js';
import { FIELD_KINDS, MAX_CATEGORY_FIELDS, MAX_FIELD_OPTIONS } from '../constants.js';
import { FIELD_KIND_KEY, useCategoryForm, type CategorySaveOutcome } from '../category-form.js';
import { ti, type InventoryKey } from '../i18n.js';
import type { CategoryRow } from '../queries.js';
import { useInventoryQuery } from '../runtime.js';

/** "Sparepart · 3 isian", or that it is archived. */
function categorySummary(category: CategoryRow): string {
  if (category.archived) return ti('inventory.category.archived');
  return [
    category.isPart ? ti('inventory.category.isPart') : '',
    ti('inventory.category.fieldCount', { count: category.fields.length }),
  ]
    .filter((s) => s !== '')
    .join(' · ');
}

// ── CategoryList ───────────────────────────────────────────────────────────────────────────────

export interface CategoryListProps {
  readonly chrome: ScreenChrome;
  readonly onBack: () => void;
  readonly onOpen: (category: CategoryRow) => void;
  readonly onAdd: () => void;
  readonly notice?: string | null | undefined;
  readonly onClearNotice?: (() => void) | undefined;
  readonly testID?: string | undefined;
}

export function CategoryList({
  chrome,
  onBack,
  onOpen,
  onAdd,
  notice,
  onClearNotice,
  testID = 'inventory.categories',
}: CategoryListProps): React.JSX.Element {
  const [nonce, setNonce] = useState(0);
  const query = useInventoryQuery<readonly CategoryRow[]>(
    async (rt) => (await rt.query('listCategories', { includeArchived: true })).rows,
    `categories:${String(nonce)}`,
  );
  return (
    <FlowScreen
      chrome={chrome}
      title={ti('inventory.category.listTitle')}
      onBack={onBack}
      primaryLabel={ti('inventory.category.add')}
      onPrimary={onAdd}
      notice={notice}
      onClearNotice={onClearNotice}
      busy={false}
      errorCode={null}
      onClearError={() => undefined}
      testID={testID}
    >
      <QueryView
        query={query}
        onBack={onBack}
        onRetry={() => setNonce((n) => n + 1)}
        testID={testID}
      >
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState
              title={ti('inventory.category.none')}
              hint={ti('inventory.category.noneHint')}
              testID={`${testID}.empty`}
            />
          ) : (
            <Rows style={styles.list}>
              {/* Archived ones last: they are kept for the items still in them. */}
              {[...rows.filter((c) => !c.archived), ...rows.filter((c) => c.archived)].map(
                (category) => (
                  <ListRow
                    key={category.id}
                    primaryText={category.name}
                    secondaryText={categorySummary(category)}
                    showChevron
                    onPress={() => onOpen(category)}
                    testID={`${testID}.row.${category.id}`}
                  />
                ),
              )}
            </Rows>
          )
        }
      </QueryView>
    </FlowScreen>
  );
}

// ── CategoryForm ───────────────────────────────────────────────────────────────────────────────

export interface CategoryFormProps {
  readonly chrome: ScreenChrome;
  /** The category being edited; absent to add one. */
  readonly category?: CategoryRow | undefined;
  /** Saved: with the notice to show, which says how many item names changed. */
  readonly onDone: (notice: string | null) => void;
  readonly onCancel: () => void;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID?: string | undefined;
}

export function CategoryForm({
  chrome,
  category,
  onDone,
  onCancel,
  onRegisterDiscardGuard,
  testID = 'inventory.categoryForm',
}: CategoryFormProps): React.JSX.Element {
  const form = useCategoryForm(category);
  const { draft, format, dirty, problems, tried, runner, example } = form;
  const [open, setOpen] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
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

  const finish = (outcome: CategorySaveOutcome): void => {
    if (outcome.status === 'saved') onDone(outcome.notice);
    else if (outcome.status === 'blocked' && outcome.field !== undefined) setOpen(outcome.field);
  };
  const save = (): void => void form.save().then(finish);
  const run = (archived: boolean): void => void form.setArchived(archived).then(finish);
  const addField = (): void => setOpen(form.addField());
  const removeField = (id: string): void => {
    form.removeField(id);
    setOpen(null);
  };

  const archiveSheet = confirmArchive ? (
    <ConfirmSheet
      title={ti('inventory.category.archiveTitle')}
      message={ti('inventory.category.archiveMessage')}
      confirmLabel={ti('inventory.category.archive')}
      onConfirm={() => {
        setConfirmArchive(false);
        run(true);
      }}
      cancelLabel={t('core.action.cancel')}
      onCancel={() => setConfirmArchive(false)}
      testID={`${testID}.archiveSheet`}
    />
  ) : null;

  return (
    <FlowScreen
      chrome={chrome}
      title={ti(
        category === undefined ? 'inventory.category.addTitle' : 'inventory.category.editTitle',
      )}
      onBack={() => discard.requestLeave(onCancel)}
      primaryLabel={ti('inventory.action.save')}
      onPrimary={save}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      overlay={discard.overlay ?? archiveSheet}
      testID={testID}
    >
      <View style={styles.groups}>
        <TextInput
          label={ti('inventory.category.name')}
          placeholder={ti('inventory.category.namePlaceholder')}
          value={draft.name}
          onChangeText={(name) => form.set({ name })}
          maxLength={MAX_CATEGORY_NAME}
          errorMessage={tried && problems.name !== null ? ti(problems.name) : undefined}
          testID={`${testID}.name`}
        />
        <SwitchRow
          label={ti('inventory.category.isPart')}
          caption={ti('inventory.category.isPartCaption')}
          value={draft.isPart}
          onValueChange={(isPart) => form.set({ isPart })}
          testID={`${testID}.isPart`}
        />
        <View>
          <Text style={styles.groupTitle}>{ti('inventory.category.fields')}</Text>
          <Text style={styles.hint}>{ti('inventory.category.fieldsHint')}</Text>
          {draft.fields.length === 0 ? null : (
            <View style={styles.rows} testID={`${testID}.fields`}>
              <ReorderableList
                items={draft.fields}
                keyOf={(field) => field.id}
                onMove={form.moveField}
                handleLabel={ti('inventory.category.dragHandle')}
                moveUpLabel={ti('inventory.category.moveUp')}
                moveDownLabel={ti('inventory.category.moveDown')}
                testID={`${testID}.order`}
                renderItem={(field, handle) => (
                  <FieldRow
                    field={field}
                    expanded={open === field.id}
                    handle={open === field.id ? null : handle}
                    problem={tried ? problems.fields.get(field.id) : undefined}
                    onToggle={() => setOpen((id) => (id === field.id ? null : field.id))}
                    onChange={(patch) => form.updateField(field.id, patch)}
                    onRemove={() => removeField(field.id)}
                    testID={`${testID}.field.${field.id}`}
                  />
                )}
              />
            </View>
          )}
          {draft.fields.length >= MAX_CATEGORY_FIELDS ? null : (
            <View style={styles.inlineAction}>
              <TextButton
                label={ti('inventory.category.addField')}
                icon="add"
                onPress={addField}
                testID={`${testID}.addField`}
              />
            </View>
          )}
          {tried
            ? problems.list.map((problem) => (
                <Text key={problem} style={styles.error}>
                  {problem}
                </Text>
              ))
            : null}
        </View>
        <View>
          <TextInput
            label={ti('inventory.category.format')}
            value={format}
            onChangeText={form.setFormat}
            maxLength={MAX_NAME_FORMAT}
            autoCorrect={false}
            errorMessage={tried && problems.format !== null ? problems.format : undefined}
            testID={`${testID}.format`}
          />
          {draft.fields.some((f) => f.label.trim() !== '') ? (
            <View style={styles.tokens}>
              <Text style={styles.hint}>{ti('inventory.category.formatHint')}</Text>
              <ChipRow testID={`${testID}.tokens`}>
                {draft.fields
                  .filter((f) => f.label.trim() !== '')
                  .map((f) => (
                    <ActionChip
                      key={f.id}
                      label={f.label.trim()}
                      icon="add"
                      accessibilityLabel={ti('inventory.category.addToName', {
                        label: f.label.trim(),
                      })}
                      onPress={() => form.addToken(f.label)}
                      testID={`${testID}.token.${f.id}`}
                    />
                  ))}
              </ChipRow>
            </View>
          ) : null}
          {example === '' ? null : (
            <View style={styles.example} testID={`${testID}.example`}>
              <Text style={styles.exampleText}>
                {ti('inventory.category.example', { name: example })}
              </Text>
            </View>
          )}
        </View>
        {category === undefined ? null : (
          <View style={styles.inlineAction}>
            {category.archived ? (
              <TextButton
                label={ti('inventory.category.restore')}
                onPress={() => run(false)}
                disabled={runner.busy}
                testID={`${testID}.restore`}
              />
            ) : (
              <TextButton
                label={ti('inventory.category.archive')}
                tone="danger"
                onPress={() => setConfirmArchive(true)}
                disabled={runner.busy}
                testID={`${testID}.archive`}
              />
            )}
          </View>
        )}
      </View>
    </FlowScreen>
  );
}

/**
 * One field: its name and what kind it is. Tapped open, its name, kind and choices are edited in
 * place; the handle drags it to another place in the list.
 */
function FieldRow({
  field,
  expanded,
  handle,
  problem,
  onToggle,
  onChange,
  onRemove,
  testID,
}: {
  readonly field: CategoryField;
  readonly expanded: boolean;
  readonly handle: ReactNode;
  readonly problem: InventoryKey | undefined;
  readonly onToggle: () => void;
  readonly onChange: (patch: Partial<CategoryField>) => void;
  readonly onRemove: () => void;
  readonly testID: string;
}): React.JSX.Element {
  const picks = field.kind === 'one' || field.kind === 'many';
  const summary = [
    ti(FIELD_KIND_KEY[field.kind]),
    picks && field.options.length > 0
      ? ti('inventory.category.optionCount', { count: field.options.length })
      : '',
  ]
    .filter((s) => s !== '')
    .join(' · ');

  if (expanded) {
    return (
      <View style={[styles.row, styles.expanded]} testID={testID}>
        <View style={styles.groups}>
          <TextInput
            label={ti('inventory.category.fieldLabel')}
            placeholder={ti('inventory.category.fieldLabelPlaceholder')}
            value={field.label}
            onChangeText={(label) => onChange({ label: label.replace(/[{}]/g, '') })}
            maxLength={MAX_FIELD_LABEL}
            errorMessage={problem === undefined ? undefined : ti(problem)}
            autoFocus={field.label === ''}
            testID={`${testID}.label`}
          />
          <SegmentedControl
            options={FIELD_KINDS.map((kind) => ({ value: kind, label: ti(FIELD_KIND_KEY[kind]) }))}
            value={field.kind}
            onChange={(kind) => onChange({ kind })}
            size="compact"
            wrap
            testID={`${testID}.kind`}
          />
          {picks ? (
            <OptionsEditor
              options={field.options}
              onChange={(options) => onChange({ options })}
              testID={`${testID}.options`}
            />
          ) : null}
        </View>
        <View style={styles.actions}>
          <TextButton
            label={ti('inventory.category.done')}
            onPress={onToggle}
            testID={`${testID}.done`}
          />
          <TextButton
            label={ti('inventory.category.removeField')}
            icon="remove"
            tone="danger"
            onPress={onRemove}
            testID={`${testID}.remove`}
          />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.row, styles.collapsed, handle === null ? null : styles.withHandle]}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityState={{ expanded: false }}
        accessibilityLabel={[field.label, summary].filter((s) => s !== '').join(', ')}
        accessibilityHint={t('core.action.edit')}
        onPress={onToggle}
        style={({ pressed }) => [styles.rowPress, pressed ? styles.pressed : null]}
      >
        <View style={styles.rowText}>
          <ValueText lines={1} style={styles.fieldName}>
            {field.label === '' ? ' ' : field.label}
          </ValueText>
          {problem === undefined ? (
            <Text style={styles.caption}>{summary}</Text>
          ) : (
            <Text style={styles.rowProblem}>{ti(problem)}</Text>
          )}
        </View>
        <Text style={styles.editLabel}>{t('core.action.edit')}</Text>
      </Pressable>
      {handle}
    </View>
  );
}

/** A field's choices: each removable, and a field to type the next ones in. */
function OptionsEditor({
  options,
  onChange,
  testID,
}: {
  readonly options: readonly string[];
  readonly onChange: (options: readonly string[]) => void;
  readonly testID: string;
}): React.JSX.Element {
  const [typed, setTyped] = useState('');
  const add = (): void => {
    const next = typed.trim().replace(/\s+/g, ' ');
    setTyped('');
    if (next === '' || options.some((o) => valueKey(o) === valueKey(next))) return;
    onChange([...options, next]);
  };
  return (
    <View testID={testID}>
      <Text style={styles.label}>{ti('inventory.category.options')}</Text>
      {options.length === 0 ? (
        <Text style={styles.caption}>{ti('inventory.category.noOptions')}</Text>
      ) : (
        <View style={styles.optionChips}>
          {options.map((option) => (
            <Chip
              key={valueKey(option)}
              label={option}
              icon="remove"
              onPress={() => onChange(options.filter((o) => o !== option))}
              accessibilityLabel={ti('inventory.category.removeOption', { option })}
              testID={`${testID}.option.${valueKey(option)}`}
            />
          ))}
        </View>
      )}
      {options.length >= MAX_FIELD_OPTIONS ? null : (
        <View style={styles.optionField}>
          <TextInput
            label={ti('inventory.category.newOption')}
            value={typed}
            onChangeText={setTyped}
            onSubmitEditing={add}
            onBlur={add}
            maxLength={MAX_FIELD_VALUE}
            autoCorrect={false}
            testID={`${testID}.new`}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { marginHorizontal: -space.lg },
  groups: { gap: space.lg },
  groupTitle: { ...type.bodyBold, color: color.text },
  hint: { ...type.bodySm, color: color.textMuted, marginTop: space.xs, marginBottom: space.sm },
  label: { ...type.caption, color: color.textMuted, marginBottom: space.xs },
  caption: { ...type.caption, color: color.textMuted, marginTop: space.xs },
  error: { ...type.caption, color: color.danger, marginTop: space.xs },
  rows: {
    marginTop: space.sm,
    marginHorizontal: -space.lg,
  },
  row: {
    paddingHorizontal: space.lg,
    backgroundColor: color.surface,
  },
  collapsed: { minHeight: touch.rowMin, flexDirection: 'row', alignItems: 'center' },
  withHandle: { paddingRight: space.xs },
  rowPress: {
    flex: 1,
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
  },
  pressed: { opacity: 0.6 },
  expanded: { backgroundColor: color.surfaceAlt, paddingVertical: space.md },
  rowText: { flex: 1 },
  fieldName: { ...type.bodyBold, color: color.text },
  rowProblem: { ...type.caption, color: color.danger, marginTop: space.xs },
  editLabel: { ...type.bodySm, fontWeight: '600', color: color.primary },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: space.sm,
    marginHorizontal: -space.sm,
  },
  // A white box, so the grey chips stand out from the open field's grey.
  optionChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginTop: space.xs,
    padding: space.sm,
    borderRadius: radius.sm,
    backgroundColor: color.surface,
  },
  optionField: { marginTop: space.md },
  tokens: { marginTop: space.sm },
  example: {
    marginTop: space.md,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceAlt,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  exampleText: { ...type.bodySm, color: color.text },
  // Text buttons line their text up with the field's left edge, not their hit box.
  inlineAction: { flexDirection: 'row', marginTop: space.xs, marginLeft: -space.sm },
});
