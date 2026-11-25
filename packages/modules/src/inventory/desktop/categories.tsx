// The business owner's categories on the counter PC (owner decision, 2026-10-28), with the same
// rules as the phone (`useCategoryForm`): each lists the fields its items fill in and a name format
// built from them, and says whether its items are spareparts a servisan can take. The page lists
// them; a dialog adds or edits one, every field open at once since a PC has the room.
import { t } from '@bolusi/i18n';
import {
  Banner,
  Button,
  Chip,
  ConfirmDialog,
  DataTable,
  IconButton,
  PageHeader,
  Segmented,
  SortableList,
  StatePanel,
  Switch,
  TextField,
  controlClass,
  type ColumnDef,
} from '@bolusi/ui-web';
import { Archive, ArrowLeft, Plus, Tags, Wrench, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { QueryPanel, TaskDialog, overlayOpen } from '../../screen-kit/desktop/index.js';
import {
  MAX_CATEGORY_NAME,
  MAX_FIELD_LABEL,
  MAX_FIELD_VALUE,
  MAX_NAME_FORMAT,
  valueKey,
} from '../categories.js';
import { FIELD_KIND_KEY, useCategoryForm } from '../category-form.js';
import { FIELD_KINDS, MAX_CATEGORY_FIELDS, MAX_FIELD_OPTIONS } from '../constants.js';
import { ti } from '../i18n.js';
import type { CategoryRow } from '../queries.js';
import { useInventoryQuery } from '../runtime.js';
import { discardCopy } from './dialogs.js';

export interface CategoriesPageProps {
  /** Back to the parts list. */
  readonly onBack: () => void;
}

export function CategoriesPage({ onBack }: CategoriesPageProps): React.JSX.Element {
  const [nonce, setNonce] = useState(0);
  // null: no dialog; 'new': adding one; otherwise the category being edited.
  const [open, setOpen] = useState<CategoryRow | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const query = useInventoryQuery<readonly CategoryRow[]>(
    async (rt) => (await rt.query('listCategories', { includeArchived: true })).rows,
    `desk.categories:${String(nonce)}`,
  );
  const rows =
    query.status === 'ready'
      ? // Archived ones last: they are kept for the items still in them.
        [...query.data.filter((c) => !c.archived), ...query.data.filter((c) => c.archived)]
      : [];

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (overlayOpen()) return;
      if (event.key === 'F2') {
        event.preventDefault();
        setOpen('new');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const empty =
    query.status === 'unauthorized' || query.status === 'error' ? (
      <QueryPanel query={query} onRetry={() => setNonce((n) => n + 1)}>
        {() => null}
      </QueryPanel>
    ) : (
      <StatePanel
        icon={Tags}
        title={ti('inventory.category.none')}
        hint={ti('inventory.category.noneHint')}
        action={
          <Button
            label={ti('inventory.category.add')}
            variant="primary"
            icon={Plus}
            onClick={() => setOpen('new')}
          />
        }
      />
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="inventory.desk.categories">
      <PageHeader
        title={ti('inventory.category.listTitle')}
        leading={
          <IconButton
            icon={ArrowLeft}
            label={ti('inventory.list.title')}
            className="-ml-2"
            onClick={onBack}
            data-testid="inventory.desk.categories.back"
          />
        }
        actions={
          <Button
            label={ti('inventory.category.add')}
            variant="primary"
            icon={Plus}
            shortcut="F2"
            onClick={() => setOpen('new')}
            data-testid="inventory.desk.categories.add"
          />
        }
      />
      {notice === null ? null : (
        <div className="px-6 pb-3">
          <Banner
            tone="success"
            message={notice}
            onDismiss={() => setNotice(null)}
            dismissLabel={t('core.action.close')}
          />
        </div>
      )}
      <DataTable
        rows={rows}
        columns={COLUMNS()}
        getRowId={(row) => row.id}
        selectedId={open === null || open === 'new' ? null : open.id}
        onSelect={(row) => setOpen(row)}
        onActivate={(row) => setOpen(row)}
        loading={query.status === 'loading'}
        empty={empty}
        label={ti('inventory.category.listTitle')}
        testId="inventory.desk.categories.table"
      />
      {open === null ? null : (
        <CategoryDialog
          // A fresh form per category.
          key={open === 'new' ? 'new' : open.id}
          category={open === 'new' ? undefined : open}
          onClose={() => setOpen(null)}
          onDone={(saved) => {
            setOpen(null);
            if (saved !== null) setNotice(saved);
          }}
        />
      )}
    </div>
  );
}

type Column = ColumnDef<CategoryRow, unknown>;

function COLUMNS(): Column[] {
  return [
    {
      id: 'name',
      accessorFn: (row) => row.name,
      header: ti('inventory.category.name'),
      meta: { track: 'minmax(200px, 2fr)' },
      cell: ({ row: { original: row } }) => (
        <span className="flex min-w-0 flex-col">
          <span
            className={
              row.archived
                ? 'truncate text-body font-semibold text-text-muted'
                : 'truncate text-body font-semibold text-text'
            }
          >
            {row.name}
          </span>
          <span className="truncate text-small text-text-muted">{row.nameFormat}</span>
        </span>
      ),
    },
    {
      id: 'fields',
      accessorFn: (row) => row.fields.map((f) => f.label).join(' · '),
      header: ti('inventory.category.fields'),
      meta: { track: 'minmax(200px, 3fr)', fold: 1 },
      cell: ({ getValue }) => (
        <span className="truncate text-body text-text">{String(getValue()) || '–'}</span>
      ),
    },
    {
      id: 'kind',
      accessorFn: (row) => (row.archived ? 2 : row.isPart ? 0 : 1),
      header: '',
      enableSorting: false,
      meta: { track: '148px' },
      cell: ({ row: { original: row } }) =>
        row.archived ? (
          <Chip label={ti('inventory.category.archived')} icon={Archive} />
        ) : row.isPart ? (
          <Chip label={ti('inventory.category.isPart')} icon={Wrench} tone="info" />
        ) : null,
    },
  ];
}

export interface CategoryDialogProps {
  /** The category being edited; absent to add one. */
  readonly category?: CategoryRow | undefined;
  readonly onClose: () => void;
  /** Saved, with the notice to show (how many names changed), or null when nothing changed. */
  readonly onDone: (notice: string | null) => void;
}

export function CategoryDialog({
  category,
  onClose,
  onDone,
}: CategoryDialogProps): React.JSX.Element {
  const form = useCategoryForm(category);
  const { draft, problems, tried } = form;
  const [confirmArchive, setConfirmArchive] = useState(false);
  // The field just added gets the keyboard, so its name is typed straight away.
  const [focusField, setFocusField] = useState<string | null>(null);
  const testId = 'inventory.desk.category';
  const labelled = draft.fields.filter((f) => f.label.trim() !== '');

  const finish = (outcome: Awaited<ReturnType<typeof form.save>>): void => {
    if (outcome.status === 'saved') onDone(outcome.notice);
    if (outcome.status !== 'blocked') return;
    // The first thing to fix gets the keyboard, scrolled into sight in a long dialog.
    const target =
      problems.name !== null
        ? `${testId}.name`
        : outcome.field !== undefined
          ? `${testId}.field.${outcome.field}.label`
          : problems.format !== null
            ? `${testId}.format`
            : null;
    if (target !== null) document.querySelector<HTMLElement>(`[data-testid="${target}"]`)?.focus();
  };

  return (
    <>
      <TaskDialog
        title={ti(form.adding ? 'inventory.category.addTitle' : 'inventory.category.editTitle')}
        runner={form.runner}
        dirty={form.dirty}
        discard={discardCopy()}
        onClose={onClose}
        submitLabel={ti('inventory.action.save')}
        onSubmit={() => void form.save().then(finish)}
        size="lg"
        testId={testId}
      >
        <TextField
          label={ti('inventory.category.name')}
          placeholder={ti('inventory.category.namePlaceholder')}
          value={draft.name}
          onChange={(event) => form.set({ name: event.target.value })}
          maxLength={MAX_CATEGORY_NAME}
          error={tried && problems.name !== null ? ti(problems.name) : undefined}
          autoFocus={form.adding}
          data-testid={`${testId}.name`}
        />
        <Switch
          label={ti('inventory.category.isPart')}
          caption={ti('inventory.category.isPartCaption')}
          checked={draft.isPart}
          onChange={(isPart) => form.set({ isPart })}
          testId={`${testId}.isPart`}
        />
        <section aria-labelledby={`${testId}.fieldsTitle`} className="flex flex-col gap-2">
          <div>
            <h3 id={`${testId}.fieldsTitle`} className="text-body font-semibold text-text">
              {ti('inventory.category.fields')}
            </h3>
            <p className="text-small text-text-muted">{ti('inventory.category.fieldsHint')}</p>
          </div>
          {draft.fields.length === 0 ? null : (
            <div className="rounded-md border border-border" data-testid={`${testId}.fields`}>
              <SortableList
                items={draft.fields}
                keyOf={(field) => field.id}
                onMove={form.moveField}
                handleLabel={ti('inventory.category.dragHandle')}
                label={ti('inventory.category.fields')}
                className="divide-y divide-border"
                testId={`${testId}.order`}
                renderItem={(field, handle) => {
                  const problem =
                    tried && problems.fields.has(field.id)
                      ? ti(problems.fields.get(field.id)!)
                      : undefined;
                  return (
                    // The kind's choices name themselves, so the row carries no labels above it.
                    <div className="flex items-start gap-2 px-3 py-3">
                      <div className="pt-0.5">{handle}</div>
                      <div className="flex min-w-0 flex-1 flex-col gap-3">
                        <div className="flex flex-wrap items-center gap-3">
                          <input
                            aria-label={ti('inventory.category.fieldLabel')}
                            aria-invalid={problem !== undefined || undefined}
                            placeholder={ti('inventory.category.fieldLabelPlaceholder')}
                            value={field.label}
                            onChange={(event) =>
                              form.updateField(field.id, {
                                label: event.target.value.replace(/[{}]/g, ''),
                              })
                            }
                            maxLength={MAX_FIELD_LABEL}
                            autoFocus={focusField === field.id}
                            className={`${controlClass(problem !== undefined)} h-9 min-w-48 flex-1 font-semibold`}
                            data-testid={`${testId}.field.${field.id}.label`}
                          />
                          <Segmented
                            options={FIELD_KINDS.map((kind) => ({
                              value: kind,
                              label: ti(FIELD_KIND_KEY[kind]),
                            }))}
                            value={field.kind}
                            onChange={(kind) => form.updateField(field.id, { kind })}
                            label={ti('inventory.category.kindLabel')}
                            size="sm"
                            testId={`${testId}.field.${field.id}.kind`}
                          />
                        </div>
                        {problem === undefined ? null : (
                          <p role="alert" className="-mt-2 text-small text-danger">
                            {problem}
                          </p>
                        )}
                        {field.kind === 'one' || field.kind === 'many' ? (
                          <OptionsEditor
                            options={field.options}
                            onChange={(options) => form.updateField(field.id, { options })}
                            testId={`${testId}.field.${field.id}.options`}
                          />
                        ) : null}
                      </div>
                      <IconButton
                        icon={X}
                        label={`${ti('inventory.category.removeField')} ${field.label}`.trim()}
                        onClick={() => form.removeField(field.id)}
                        data-testid={`${testId}.field.${field.id}.remove`}
                      />
                    </div>
                  );
                }}
              />
            </div>
          )}
          {draft.fields.length >= MAX_CATEGORY_FIELDS ? null : (
            <div className="-ml-2">
              <Button
                label={ti('inventory.category.addField')}
                icon={Plus}
                variant="text"
                onClick={() => setFocusField(form.addField())}
                data-testid={`${testId}.addField`}
              />
            </div>
          )}
          {tried
            ? problems.list.map((problem) => (
                <p key={problem} role="alert" className="text-small text-danger">
                  {problem}
                </p>
              ))
            : null}
        </section>
        <section className="flex flex-col gap-2">
          <TextField
            label={ti('inventory.category.format')}
            value={form.format}
            onChange={(event) => form.setFormat(event.target.value)}
            maxLength={MAX_NAME_FORMAT}
            spellCheck={false}
            error={tried && problems.format !== null ? problems.format : undefined}
            data-testid={`${testId}.format`}
          />
          {labelled.length === 0 ? null : (
            <div className="flex flex-wrap items-center gap-2" data-testid={`${testId}.tokens`}>
              <span className="text-small text-text-muted">
                {ti('inventory.category.formatHintPc')}
              </span>
              {labelled.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => form.addToken(f.label)}
                  aria-label={ti('inventory.category.addToName', { label: f.label.trim() })}
                  className="inline-flex h-8 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border border-border bg-surface px-3 text-small font-medium text-text hover:bg-surface-alt"
                  data-testid={`${testId}.token.${f.id}`}
                >
                  <Plus size={14} aria-hidden />
                  {f.label.trim()}
                </button>
              ))}
            </div>
          )}
          {form.example === '' ? null : (
            <p
              className="rounded-sm bg-surface-alt px-3 py-2 text-body text-text"
              data-testid={`${testId}.example`}
            >
              {ti('inventory.category.example', { name: form.example })}
            </p>
          )}
        </section>
        {category === undefined ? null : (
          <div className="-ml-2 border-t border-border pt-3">
            {category.archived ? (
              <Button
                label={ti('inventory.category.restore')}
                variant="text"
                onClick={() => void form.setArchived(false).then(finish)}
                disabled={form.runner.busy}
                data-testid={`${testId}.restore`}
              />
            ) : (
              <Button
                label={ti('inventory.category.archive')}
                variant="dangerText"
                onClick={() => setConfirmArchive(true)}
                disabled={form.runner.busy}
                data-testid={`${testId}.archive`}
              />
            )}
          </div>
        )}
      </TaskDialog>
      <ConfirmDialog
        open={confirmArchive}
        title={ti('inventory.category.archiveTitle')}
        message={ti('inventory.category.archiveMessage')}
        confirmLabel={ti('inventory.category.archive')}
        cancelLabel={t('core.action.back')}
        closeLabel={t('core.action.close')}
        destructive
        onConfirm={() => {
          setConfirmArchive(false);
          void form.setArchived(true).then(finish);
        }}
        onCancel={() => setConfirmArchive(false)}
        testId={`${testId}.archiveConfirm`}
      />
    </>
  );
}

/** A field's choices: each removable, and a box to type the next one in (Enter adds it). */
function OptionsEditor({
  options,
  onChange,
  testId,
}: {
  readonly options: readonly string[];
  readonly onChange: (options: readonly string[]) => void;
  readonly testId: string;
}): React.JSX.Element {
  const [typed, setTyped] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const add = (): void => {
    const next = typed.trim().replace(/\s+/g, ' ');
    setTyped('');
    if (next === '' || options.some((o) => valueKey(o) === valueKey(next))) return;
    onChange([...options, next]);
  };
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <span className="text-small text-text-muted">{ti('inventory.category.options')}</span>
      <div
        className="flex flex-wrap items-center gap-2 rounded-sm border border-border bg-surface p-1.5"
        onClick={(event) => {
          if (event.target === event.currentTarget) inputRef.current?.focus();
        }}
      >
        {options.map((option) => (
          <span
            key={valueKey(option)}
            className="inline-flex h-7 items-center gap-1 rounded-full bg-surface-alt pl-3 pr-1 text-small font-medium text-text"
          >
            {option}
            <button
              type="button"
              aria-label={ti('inventory.category.removeOption', { option })}
              onClick={() => onChange(options.filter((o) => o !== option))}
              className="flex size-5 cursor-pointer items-center justify-center rounded-full text-text-muted hover:bg-black/10 hover:text-text"
              data-testid={`${testId}.option.${valueKey(option)}.remove`}
            >
              <X size={12} aria-hidden />
            </button>
          </span>
        ))}
        {options.length >= MAX_FIELD_OPTIONS ? null : (
          <input
            ref={inputRef}
            aria-label={ti('inventory.category.newOption')}
            placeholder={
              options.length === 0
                ? ti('inventory.category.optionsPlaceholder')
                : ti('inventory.category.newOption')
            }
            value={typed}
            maxLength={MAX_FIELD_VALUE}
            onChange={(event) => setTyped(event.target.value)}
            // Enter (or a comma) adds the choice here, not the whole dialog; Backspace in an empty
            // box takes the last one off, as in any tag box.
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault();
                add();
              } else if (event.key === 'Backspace' && typed === '' && options.length > 0) {
                onChange(options.slice(0, -1));
              }
            }}
            onBlur={add}
            className="h-7 min-w-40 flex-1 bg-transparent px-1 text-body text-text outline-none placeholder:text-text-disabled"
            data-testid={`${testId}.new`}
          />
        )}
      </div>
    </div>
  );
}
