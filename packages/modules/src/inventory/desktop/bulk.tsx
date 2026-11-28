// Entering a shelf of items at one sitting on the counter PC (owner decision, 2026-10-28): pick the
// category, then fill a sheet with one column per field, typed or pasted from Excel, and save every
// ready row at once. The rules are `useBulkEntry`'s; this page lays out the sheet.
import { formatNumber, t } from '@bolusi/i18n';
import {
  Banner,
  Button,
  ConfirmDialog,
  EditableGrid,
  IconButton,
  PageHeader,
  controlClass,
  type CellProblem,
  type GridColumn,
} from '@bolusi/ui-web';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import type { BulkColumn, BulkColumnKind } from '../bulk-entry.js';
import { MAX_FIELD_VALUE } from '../categories.js';
import { useBulkEntry, newBulkRow } from '../bulk-form.js';
import { ti } from '../i18n.js';
import { MAX_BARCODE, MAX_PART_CODE, MAX_PART_NAME } from '../operations.js';

const NONE = '';

const WIDTH: Readonly<Record<BulkColumnKind, number>> = {
  field: 160,
  fits: 260,
  name: 320,
  code: 120,
  barcode: 160,
  tags: 180,
  stock: 88,
};

const MAX_LENGTH: Partial<Record<BulkColumnKind, number>> = {
  name: MAX_PART_NAME,
  code: MAX_PART_CODE,
  barcode: MAX_BARCODE,
};

/** What leaving the sheet does, asked by the app before it moves to another page. */
export type LeaveGuard = (proceed: () => void) => void;

export interface BulkAddPageProps {
  readonly onBack: () => void;
  readonly onRegisterLeaveGuard?: ((guard: LeaveGuard | null) => void) | undefined;
}

export function BulkAddPage({ onBack, onRegisterLeaveGuard }: BulkAddPageProps): React.JSX.Element {
  const entry = useBulkEntry();
  const { category, read, rows } = entry;
  const selectId = useId();
  const [pendingCategory, setPendingCategory] = useState<string | null | undefined>(undefined);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const testId = 'inventory.desk.bulk';
  const dirty = entry.filled > 0;
  const saving = entry.progress !== null;

  // Another page (the sidebar, a person switch) asks before the sheet is lost.
  const guard = useRef<LeaveGuard>((proceed) => proceed());
  guard.current = (proceed) => (dirty ? setLeaving(() => proceed) : proceed());
  useEffect(() => {
    onRegisterLeaveGuard?.((proceed) => guard.current(proceed));
    return () => onRegisterLeaveGuard?.(null);
  }, [onRegisterLeaveGuard]);

  const byId = useMemo(() => new Map(rows.map((row, i) => [row.id, read[i]])), [rows, read]);
  const columns: GridColumn[] = entry.columns.map((column: BulkColumn) => {
    const list =
      column.kind === 'tags' ||
      column.kind === 'fits' ||
      (column.kind === 'field' && column.field?.kind === 'many');
    const suggestions = entry.suggestions(column);
    return {
      id: column.id,
      label: column.label,
      aliases: column.aliases,
      width: WIDTH[column.kind],
      align: column.kind === 'stock' ? 'end' : 'start',
      numeric: column.kind === 'stock',
      multiple: list,
      maxLength: MAX_LENGTH[column.kind] ?? (column.kind === 'field' ? MAX_FIELD_VALUE : undefined),
      ...(suggestions.length > 0 ? { suggestions } : {}),
      hint:
        column.kind === 'name' && category !== null
          ? ti('inventory.bulk.hint.name', { format: category.nameFormat })
          : column.kind === 'fits'
            ? ti('inventory.bulk.hint.fits')
            : list
              ? ti('inventory.bulk.hint.list')
              : undefined,
      ...(column.kind === 'name' && category !== null
        ? {
            placeholder: (row: { id: string }) => {
              const r = byId.get(row.id);
              return r?.filled === true ? r.builtName : undefined;
            },
          }
        : {}),
    };
  });
  const problems = useMemo(() => {
    const map = new Map<string, Readonly<Record<string, CellProblem>>>();
    rows.forEach((row, i) => {
      const found = read[i]?.problems;
      if (found !== undefined && Object.keys(found).length > 0) map.set(row.id, found);
    });
    return map;
  }, [rows, read]);

  // Rows marked red; a row still being typed is not counted until saving is tried.
  const blocked = read.filter(
    (r) => r.filled && Object.values(r.problems).some((p) => p.tone === 'danger'),
  ).length;
  const pick = (value: string): void => {
    const id = value === NONE ? null : value;
    if (dirty) setPendingCategory(id);
    else entry.pickCategory(id);
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid={testId}
      // The window's close guard asks before typed rows are lost.
      data-unsaved={dirty || undefined}
    >
      <PageHeader
        title={ti('inventory.bulk.title')}
        leading={
          <IconButton
            icon={ArrowLeft}
            label={ti('inventory.list.title')}
            className="-ml-2"
            onClick={() => guard.current(onBack)}
            data-testid={`${testId}.back`}
          />
        }
        actions={
          <Button
            label={
              saving
                ? ti('inventory.bulk.saving', {
                    done: formatNumber(entry.progress!.done),
                    total: formatNumber(entry.progress!.total),
                  })
                : entry.ready > 0
                  ? ti('inventory.bulk.save', { count: formatNumber(entry.ready) })
                  : ti('inventory.action.save')
            }
            variant="primary"
            busy={saving}
            disabled={entry.filled === 0}
            onClick={() => void entry.save()}
            data-testid={`${testId}.save`}
          />
        }
      >
        <div className="flex min-w-0 items-center gap-3">
          <label htmlFor={selectId} className="shrink-0 text-body font-semibold text-text">
            {ti('inventory.form.category')}
          </label>
          <select
            id={selectId}
            value={category?.id ?? NONE}
            onChange={(event) => pick(event.target.value)}
            disabled={saving}
            className={`${controlClass(false)} h-9 w-56 min-w-0 cursor-pointer`}
            data-testid={`${testId}.category`}
          >
            <option value={NONE}>{ti('inventory.list.noCategory')}</option>
            {entry.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </PageHeader>
      {entry.notice === null ? null : (
        <div className="px-6 pb-3">
          <Banner
            tone={entry.left > 0 ? 'warning' : 'success'}
            message={entry.notice}
            onDismiss={entry.clearNotice}
            dismissLabel={t('core.action.close')}
          />
        </div>
      )}
      <EditableGrid
        // A new sheet for a new category: its columns are its own.
        key={category?.id ?? NONE}
        columns={columns}
        rows={rows}
        onChange={entry.setRows}
        newRow={newBulkRow}
        problems={problems}
        rowProblems={entry.refused}
        disabled={saving}
        historyKey={entry.saves}
        aside={
          blocked > 0 ? (
            <span className="font-semibold text-danger" data-testid={`${testId}.blocked`}>
              {ti('inventory.bulk.blocked', { count: formatNumber(blocked) })}
            </span>
          ) : undefined
        }
        labels={{
          row: (n) => ti('inventory.bulk.row', { n }),
          deleteRow: ti('inventory.bulk.deleteRow'),
          where: (n, column) => ti('inventory.bulk.where', { n, column }),
        }}
        label={ti('inventory.bulk.title')}
        testId={`${testId}.grid`}
      />
      <ConfirmDialog
        open={pendingCategory !== undefined}
        title={ti('inventory.bulk.switchTitle')}
        message={ti('inventory.bulk.switchMessage')}
        confirmLabel={ti('inventory.bulk.switchConfirm')}
        cancelLabel={ti('inventory.discard.keep')}
        closeLabel={t('core.action.close')}
        destructive
        onConfirm={() => {
          entry.pickCategory(pendingCategory ?? null);
          setPendingCategory(undefined);
        }}
        onCancel={() => setPendingCategory(undefined)}
        testId={`${testId}.switch`}
      />
      <ConfirmDialog
        open={leaving !== null}
        title={ti('inventory.discard.title')}
        message={ti('inventory.bulk.leaveMessage')}
        confirmLabel={ti('inventory.discard.confirm')}
        cancelLabel={ti('inventory.discard.keep')}
        closeLabel={t('core.action.close')}
        destructive
        onConfirm={() => {
          const proceed = leaving;
          setLeaving(null);
          proceed?.();
        }}
        onCancel={() => setLeaving(null)}
        testId={`${testId}.leave`}
      />
    </div>
  );
}
