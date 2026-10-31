// The parts list's tasks on the counter PC: add or edit an item, and correct its stock. Each is a
// dialog over the list, with the same rules as the phone's screens (`useItemForm`).
import { TextArea, TextField, ToggleChip } from '@bolusi/ui-web';
import { useState } from 'react';

import { useActionRunner } from '../../screen-kit/index.js';
import { TaskDialog, type DiscardCopy } from '../../screen-kit/desktop/index.js';
import { MAX_FIELD_VALUE, type CategoryField } from '../categories.js';
import { MAX_COUNTED_QTY, TAG_FACET } from '../constants.js';
import { ti } from '../i18n.js';
import { useItemForm } from '../item-form.js';
import { MAX_BARCODE, MAX_NOTE, MAX_PART_CODE, MAX_PART_NAME } from '../operations.js';
import type { ItemDetailRow, ItemFitRow, ItemRow } from '../queries.js';
import { useInventoryRuntime } from '../runtime.js';
import { ModelsPicker, QtyField, ValuePicker } from './fields.js';

export function discardCopy(): DiscardCopy {
  return {
    title: ti('inventory.discard.title'),
    message: ti('inventory.discard.message'),
    confirm: ti('inventory.discard.confirm'),
    keep: ti('inventory.discard.keep'),
  };
}

export interface PartDialogProps {
  /** The item being edited; absent to add one. */
  readonly part?: ItemDetailRow | undefined;
  /** For a new item: the category the list was showing, so it starts there. */
  readonly categoryId?: string | null | undefined;
  readonly onClose: () => void;
  /** Saved; a new item opens beside the list. */
  readonly onDone: (itemId: string) => void;
}

/**
 * Add an item to the business's list, or edit one. "Tambah lagi" saves and keeps the category,
 * fields and phones for the next item of a run, so a shelf of parts goes in at one sitting.
 */
export function PartDialog({
  part,
  categoryId,
  onClose,
  onDone,
}: PartDialogProps): React.JSX.Element {
  const form = useItemForm({ part, categoryId });
  const { draft, set, category, categories, fields, autoName, builtName, nameMissing } = form;
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const testId = 'inventory.desk.form';

  const save = (another: boolean): void => {
    setSavedNotice(null);
    void form.save(another).then((saved) => {
      if (saved === undefined) return;
      if (another) setSavedNotice(ti('inventory.form.savedAnother', { name: saved.name }));
      else onDone(saved.itemId);
    });
  };

  return (
    <TaskDialog
      title={ti(form.adding ? 'inventory.form.addTitle' : 'inventory.form.editTitle')}
      description={
        savedNotice === null ? undefined : (
          <span
            className="font-semibold text-success"
            role="status"
            data-testid={`${testId}.saved`}
          >
            {savedNotice}
          </span>
        )
      }
      runner={form.runner}
      dirty={form.dirty}
      discard={discardCopy()}
      onClose={onClose}
      submitLabel={ti('inventory.action.save')}
      onSubmit={() => save(false)}
      secondary={
        form.adding
          ? {
              label: ti('inventory.form.addAnother'),
              onClick: () => save(true),
              testId: `${testId}.another`,
            }
          : undefined
      }
      size="md"
      testId={testId}
    >
      {categories.length === 0 ? null : (
        <div role="group" aria-label={ti('inventory.form.category')}>
          <p className="mb-2 text-small font-semibold text-text">{ti('inventory.form.category')}</p>
          <div className="flex flex-wrap gap-2" data-testid={`${testId}.category`}>
            {categories.map((c) => (
              <ToggleChip
                key={c.id}
                label={c.name}
                selected={c.id === draft.categoryId}
                onToggle={() => form.pickCategory(c.id === draft.categoryId ? null : c.id)}
                testId={`${testId}.category.${c.id}`}
              />
            ))}
          </div>
        </div>
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
          testId={`${testId}.field.${field.id}`}
        />
      ))}
      {category === null ? (
        <ModelsPicker
          value={draft.fits}
          onChange={(fits) => set({ fits })}
          testId={`${testId}.fits`}
        />
      ) : null}
      {autoName ? (
        <div data-testid={`${testId}.autoName`}>
          <p className="mb-1 text-small font-semibold text-text">{ti('inventory.form.autoName')}</p>
          <div className="flex items-center gap-3 rounded-sm bg-surface-alt px-3 py-2">
            <p
              className={
                nameMissing
                  ? 'min-w-0 flex-1 text-small text-text-muted'
                  : 'min-w-0 flex-1 text-body font-semibold text-text'
              }
              data-testid={`${testId}.autoName.text`}
            >
              {nameMissing ? ti('inventory.form.autoNameEmpty') : builtName}
            </p>
            <button
              type="button"
              onClick={form.editName}
              className="shrink-0 cursor-pointer text-small font-semibold text-primary hover:underline"
              data-testid={`${testId}.editName`}
            >
              {ti('inventory.form.editName')}
            </button>
          </div>
          {form.tried && nameMissing ? (
            <p className="mt-1 text-small text-danger">{ti('inventory.form.nameRequired')}</p>
          ) : null}
        </div>
      ) : (
        <div>
          <TextField
            label={ti('inventory.form.name')}
            placeholder={ti('inventory.form.namePlaceholder')}
            value={draft.name}
            onChange={(event) => set({ name: event.target.value })}
            maxLength={MAX_PART_NAME}
            error={form.tried && nameMissing ? ti('inventory.form.nameRequired') : undefined}
            autoFocus={!form.adding || categories.length === 0}
            data-testid={`${testId}.name`}
          />
          {category === null ? null : (
            <button
              type="button"
              onClick={() => set({ nameAuto: true })}
              className="mt-1 cursor-pointer text-small font-semibold text-primary hover:underline"
              data-testid={`${testId}.useAutoName`}
            >
              {ti('inventory.form.useAutoName')}
            </button>
          )}
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          label={ti('inventory.form.code')}
          value={draft.code}
          onChange={(event) => set({ code: event.target.value })}
          maxLength={MAX_PART_CODE}
          data-testid={`${testId}.code`}
        />
        {/* A USB scanner types the code and presses Enter, which here only ends the field. */}
        <TextField
          label={ti('inventory.form.barcode')}
          value={draft.barcode}
          onChange={(event) => set({ barcode: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.preventDefault();
          }}
          maxLength={MAX_BARCODE}
          data-testid={`${testId}.barcode`}
        />
      </div>
      <ValuePicker
        label={ti('inventory.form.tags')}
        options={form.usedValues(TAG_FACET)}
        value={draft.tags}
        onChange={(tags) => set({ tags })}
        multiple
        addLabel={ti('inventory.form.addTag')}
        newLabel={ti('inventory.form.newTag')}
        testId={`${testId}.tags`}
      />
      {form.canCount ? (
        <QtyField
          label={ti('inventory.form.stock')}
          value={form.stock}
          onChange={form.setStock}
          max={MAX_COUNTED_QTY}
          testId={`${testId}.stock`}
        />
      ) : null}
    </TaskDialog>
  );
}

/** One of the category's fields: chips for a pick, a box for text, the phone picker for phones. */
function FieldInput({
  field,
  values,
  used,
  fits,
  onValues,
  onFits,
  testId,
}: {
  readonly field: CategoryField;
  readonly values: readonly string[];
  readonly used: readonly string[];
  readonly fits: readonly ItemFitRow[];
  readonly onValues: (values: readonly string[]) => void;
  readonly onFits: (fits: readonly ItemFitRow[]) => void;
  readonly testId: string;
}): React.JSX.Element {
  switch (field.kind) {
    case 'phones':
      return <ModelsPicker label={field.label} value={fits} onChange={onFits} testId={testId} />;
    case 'text':
      return (
        <TextField
          label={field.label}
          value={values[0] ?? ''}
          onChange={(event) =>
            onValues(event.target.value.trim() === '' ? [] : [event.target.value])
          }
          maxLength={MAX_FIELD_VALUE}
          data-testid={testId}
        />
      );
    case 'one':
    case 'many':
      return (
        <ValuePicker
          label={field.label}
          options={[...field.options, ...used]}
          value={values}
          onChange={onValues}
          multiple={field.kind === 'many'}
          addLabel={ti('inventory.form.otherValue')}
          newLabel={ti('inventory.form.newValue')}
          testId={testId}
        />
      );
  }
}

export interface CountDialogProps {
  readonly part: ItemRow;
  readonly onClose: () => void;
  readonly onDone: () => void;
}

/**
 * Koreksi stok: what is on the shelf for one item. It starts at what the store has recorded, so a
 * matching count is one Enter, and the difference is said as it changes.
 */
export function CountDialog({ part, onClose, onDone }: CountDialogProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const runner = useActionRunner();
  const recorded = part.onHand;
  const [counted, setCounted] = useState(Math.max(0, recorded));
  const [note, setNote] = useState('');
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
    <TaskDialog
      title={ti('inventory.count.title')}
      description={part.name}
      runner={runner}
      dirty={counted !== Math.max(0, recorded) || note !== ''}
      discard={discardCopy()}
      onClose={onClose}
      submitLabel={ti('inventory.count.save')}
      onSubmit={save}
      testId="inventory.desk.count"
    >
      <QtyField
        label={ti('inventory.count.counted')}
        value={counted}
        onChange={setCounted}
        max={MAX_COUNTED_QTY}
        autoFocus
        hint={`${ti('inventory.count.recorded', { count: recorded })} · ${
          difference === 0
            ? ti('inventory.count.same')
            : difference > 0
              ? ti('inventory.count.more', { count: difference })
              : ti('inventory.count.less', { count: -difference })
        }`}
        testId="inventory.desk.count.counted"
      />
      <TextArea
        label={ti('inventory.count.note')}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        maxLength={MAX_NOTE}
        rows={2}
        data-testid="inventory.desk.count.note"
      />
    </TaskDialog>
  );
}
