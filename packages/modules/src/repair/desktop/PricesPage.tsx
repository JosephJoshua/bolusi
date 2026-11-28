// The price list on the counter PC (Servisan › Daftar harga). Everyone finds a price by phone, typos
// and all, and narrows it to a repair type. The business owner changes the list in a spreadsheet
// (`usePriceSheet`): every row where it stands, new rows at the end, pasted from Excel if they like.
// A store owner who cannot change the list sets what their store charges from a row's dialog.
import { formatMoney, formatNumber, t } from '@bolusi/i18n';
import {
  Banner,
  Button,
  ChoiceList,
  ConfirmDialog,
  DataTable,
  EditableGrid,
  FilterPopover,
  PageHeader,
  SearchField,
  StatePanel,
  Switch,
  type CellProblem,
  type ColumnDef,
  type Crumb,
  type GridColumn,
} from '@bolusi/ui-web';
import { ReceiptText, SearchX } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useActionRunner, useSettledValue } from '../../screen-kit/index.js';
import { QueryPanel, TaskDialog } from '../../screen-kit/desktop/index.js';
import { tn } from '../i18n.js';
import { MAX_PRICE_QUALITY } from '../operations.js';
import {
  priceAbilities,
  priceModelsText,
  priceTitle,
  priceTypeLabel,
  usePriceQualities,
  usePriceTypes,
  type PriceType,
} from '../price-list.js';
import type { PriceColumn } from '../price-sheet.js';
import type { PriceRow } from '../prices.queries.js';
import { useRepairQuery, useRepairRuntime } from '../runtime.js';
import { MoneyField } from './parts.js';
import { newSheetRow, usePriceSheet } from './price-sheet.js';

const ALL = 'all';
const PAGE = 100;

/** What leaving the page does, asked by the app before it moves to another page. */
export type PricesLeaveGuard = (proceed: () => void) => void;

export interface PricesPageProps {
  /** Where the page sits in its place (Servisan › Daftar harga). */
  readonly trail?: readonly Crumb[] | undefined;
  readonly onRegisterLeaveGuard?: ((guard: PricesLeaveGuard | null) => void) | undefined;
}

export function PricesPage({ trail, onRegisterLeaveGuard }: PricesPageProps): React.JSX.Element {
  const runtime = useRepairRuntime();
  const can = useMemo(() => priceAbilities(runtime.hasPermission), [runtime]);
  const types = usePriceTypes(can.edit ? 'business' : 'store');
  const [text, setText] = useState('');
  const [repairType, setRepairType] = useState<string | null>(null);
  const typed = text.trim();
  const settled = useSettledValue(typed);
  const searchText = typed === '' ? '' : settled;
  const testId = 'repair.desk.prices';

  const typeOptions = [
    { value: ALL, label: tn('repair.prices.allTypes') },
    ...(types ?? []).map((type) => ({ value: type.id, label: type.label })),
  ];
  const filters = (
    <div className="flex h-12 items-center gap-2 px-6" data-testid={`${testId}.filters`}>
      <FilterPopover
        label={tn('repair.prices.repairType')}
        summary={repairType === null ? null : priceTypeLabel(types, repairType)}
        clearLabel={tn('repair.prices.allTypes')}
        onClear={() => setRepairType(null)}
        testId={`${testId}.filter.type`}
      >
        <ChoiceList
          options={typeOptions}
          value={repairType ?? ALL}
          onChange={(value) => setRepairType(value === ALL ? null : value)}
          label={tn('repair.prices.repairType')}
          testId={`${testId}.filter.type.list`}
        />
      </FilterPopover>
    </div>
  );
  const search = (
    <div className="w-full max-w-[520px]">
      <SearchField
        value={text}
        onChange={setText}
        placeholder={tn('repair.prices.searchHint')}
        label={t('core.action.search')}
        clearLabel={tn('repair.board.clearSearch')}
        shortcut="/"
        testId={`${testId}.search`}
      />
    </div>
  );

  if (can.edit && types !== null) {
    return (
      <PriceSheetPage
        types={types}
        text={searchText}
        repairType={repairType}
        storeColumn={can.store}
        trail={trail}
        search={search}
        filters={filters}
        onRegisterLeaveGuard={onRegisterLeaveGuard}
        testId={testId}
      />
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid={testId}>
      <PageHeader title={tn('repair.prices.title')} trail={trail} trailLabel={t('core.nav.trail')}>
        {search}
      </PageHeader>
      {filters}
      <PriceTable
        types={types}
        text={searchText}
        repairType={repairType}
        storeOwner={can.store}
        testId={testId}
      />
    </div>
  );
}

// ── reading the list (everyone), and a store's own price (store owners) ───────────────────────

function PriceTable({
  types,
  text,
  repairType,
  storeOwner,
  testId,
}: {
  readonly types: readonly PriceType[] | null;
  readonly text: string;
  readonly repairType: string | null;
  readonly storeOwner: boolean;
  readonly testId: string;
}): React.JSX.Element {
  const [pages, setPages] = useState(1);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [open, setOpen] = useState<PriceRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => setPages(1), [text, repairType]);
  const query = useRepairQuery(
    async (rt) => {
      const page = await rt.query('priceList', {
        text,
        repairType,
        limit: PAGE * pages,
      });
      return { rows: page.rows, hasMore: page.nextCursor !== null };
    },
    `deskPrices:${text}:${repairType ?? ''}:${String(pages)}:${String(reloadNonce)}`,
  );
  const loaded = query.status === 'ready' ? query.data : null;
  const columns = useMemo(
    (): ColumnDef<PriceRow, unknown>[] => [
      {
        id: 'type',
        header: tn('repair.prices.repairType'),
        meta: { track: 'minmax(180px, 1.2fr)' },
        cell: ({ row }) => (
          <span className="font-semibold text-text">
            {priceTitle(priceTypeLabel(types, row.original.repairType), row.original.quality)}
          </span>
        ),
      },
      {
        id: 'models',
        header: tn('repair.prices.models'),
        meta: { track: 'minmax(220px, 2fr)', fold: 1 },
        cell: ({ row }) => (
          <span className="break-words text-text">{priceModelsText(row.original.models)}</span>
        ),
      },
      {
        id: 'amount',
        header: tn('repair.prices.amount'),
        meta: { track: 'minmax(140px, auto)', align: 'end' },
        cell: ({ row }) => (
          <span className="tabular whitespace-nowrap text-right">
            {formatMoney(row.original.amount)}
            {storeOwner && row.original.storeAmount !== null ? (
              <span className="block text-small text-text-muted">
                {tn('repair.prices.storePriced')}
              </span>
            ) : null}
          </span>
        ),
      },
    ],
    [types, storeOwner],
  );
  const narrowed = text !== '' || repairType !== null;
  const empty =
    query.status === 'unauthorized' || query.status === 'error' ? (
      <QueryPanel query={query} onRetry={() => setReloadNonce((n) => n + 1)}>
        {() => null}
      </QueryPanel>
    ) : narrowed ? (
      <StatePanel icon={SearchX} title={tn('repair.prices.noMatches')} />
    ) : (
      <StatePanel
        icon={ReceiptText}
        title={tn('repair.prices.empty')}
        hint={tn('repair.prices.emptyHint')}
      />
    );
  return (
    <>
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
        rows={loaded?.rows ?? []}
        columns={columns}
        getRowId={(row) => row.id}
        selectedId={open?.id ?? null}
        onSelect={(row) => {
          if (storeOwner) setOpen(row);
        }}
        sortable={false}
        onEndReached={() => {
          if (loaded?.hasMore === true) setPages((n) => n + 1);
        }}
        loading={query.status === 'loading'}
        empty={empty}
        label={tn('repair.prices.title')}
        testId={`${testId}.table`}
      />
      {open === null ? null : (
        <StorePriceDialog
          row={open}
          types={types}
          onClose={() => setOpen(null)}
          onDone={(saved) => {
            setOpen(null);
            setNotice(tn('repair.prices.saved', { price: saved }));
          }}
          testId={`${testId}.storeDialog`}
        />
      )}
    </>
  );
}

function StorePriceDialog({
  row,
  types,
  onClose,
  onDone,
  testId,
}: {
  readonly row: PriceRow;
  readonly types: readonly PriceType[] | null;
  readonly onClose: () => void;
  readonly onDone: (saved: string) => void;
  readonly testId: string;
}): React.JSX.Element {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [own, setOwn] = useState(row.storeAmount !== null);
  const [amount, setAmount] = useState<number | null>(row.storeAmount ?? row.listAmount);
  const next = own ? amount : null;
  const dirty = next !== row.storeAmount;
  const title = priceTitle(priceTypeLabel(types, row.repairType), row.quality);
  const missing = own && (amount === null || amount <= 0);
  const submit = (): void => {
    if (missing) return;
    if (!dirty) {
      onClose();
      return;
    }
    void runner
      .run(() => runtime.run('setStorePrices', { prices: [{ priceId: row.id, amount: next }] }))
      .then((done) => {
        if (done !== undefined) onDone(title);
      });
  };
  return (
    <TaskDialog
      title={title}
      description={priceModelsText(row.models)}
      runner={runner}
      dirty={dirty}
      discard={{
        title: tn('repair.prices.discard.title'),
        message: tn('repair.prices.discard.message'),
        confirm: tn('repair.prices.discard.confirm'),
        keep: tn('repair.prices.discard.keep'),
      }}
      onClose={onClose}
      submitLabel={tn('repair.prices.save')}
      onSubmit={submit}
      submitDisabled={missing}
      hint={missing ? tn('repair.prices.problem.amount') : null}
      testId={testId}
    >
      <div className="flex flex-col gap-4">
        <p className="text-body text-text">
          {tn('repair.prices.listAmount')}:{' '}
          <span className="tabular font-semibold">{formatMoney(row.listAmount)}</span>
        </p>
        <Switch
          label={tn('repair.prices.storeOwn')}
          caption={tn('repair.prices.storeOwnCaption')}
          checked={own}
          onChange={setOwn}
          testId={`${testId}.own`}
        />
        {own ? (
          <MoneyField
            label={tn('repair.prices.storeAmount')}
            value={amount}
            onChange={setAmount}
            data-testid={`${testId}.amount`}
          />
        ) : null}
      </div>
    </TaskDialog>
  );
}

// ── the business owner's sheet ─────────────────────────────────────────────────────────────────

const WIDTH: Readonly<Record<PriceColumn, number>> = {
  type: 200,
  models: 380,
  quality: 140,
  amount: 140,
  store: 150,
};

function PriceSheetPage({
  types,
  text,
  repairType,
  storeColumn,
  trail,
  search,
  filters,
  onRegisterLeaveGuard,
  testId,
}: {
  readonly types: readonly PriceType[];
  readonly text: string;
  readonly repairType: string | null;
  readonly storeColumn: boolean;
  readonly trail: readonly Crumb[] | undefined;
  readonly search: React.ReactNode;
  readonly filters: React.ReactNode;
  readonly onRegisterLeaveGuard: ((guard: PricesLeaveGuard | null) => void) | undefined;
  readonly testId: string;
}): React.JSX.Element {
  const sheet = usePriceSheet({ types, text, repairType, storeColumn });
  const qualities = usePriceQualities();
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const dirty = sheet.changes > 0;
  const saving = sheet.progress !== null;

  // Another page (the sidebar, a person switch) asks before the changes are lost.
  const guard = useRef<PricesLeaveGuard>((proceed) => proceed());
  guard.current = (proceed) => (dirty ? setLeaving(() => proceed) : proceed());
  useEffect(() => {
    onRegisterLeaveGuard?.((proceed) => guard.current(proceed));
    return () => onRegisterLeaveGuard?.(null);
  }, [onRegisterLeaveGuard]);

  const columns: GridColumn[] = [
    {
      id: 'type',
      label: tn('repair.prices.repairType'),
      aliases: [tn('repair.prices.sheet.typeAlias'), 'Servis', 'Jenis'],
      width: WIDTH.type,
      suggestions: types.map((type) => type.label),
    },
    {
      id: 'models',
      label: tn('repair.prices.models'),
      aliases: ['HP', 'Tipe HP', 'Model'],
      width: WIDTH.models,
      multiple: true,
      hint: tn('repair.prices.sheet.modelsHint'),
    },
    {
      id: 'quality',
      label: tn('repair.prices.qualityShort'),
      aliases: ['Kualitas', 'Grade'],
      width: WIDTH.quality,
      maxLength: MAX_PRICE_QUALITY,
      suggestions: qualities,
    },
    {
      id: 'amount',
      label: tn('repair.prices.amount'),
      aliases: ['Harga', 'Tarif'],
      width: WIDTH.amount,
      align: 'end',
      numeric: true,
    },
    ...(storeColumn
      ? [
          {
            id: 'store',
            label: tn('repair.prices.storeAmount'),
            aliases: ['Harga toko'],
            width: WIDTH.store,
            align: 'end' as const,
            numeric: true,
            hint: tn('repair.prices.sheet.storeHint'),
            placeholder: (row: { id: string; cells: Readonly<Record<string, string>> }) =>
              row.cells['amount'] === '' ? undefined : row.cells['amount'],
          },
        ]
      : []),
  ];
  const problems = useMemo(() => {
    const map = new Map<string, Readonly<Record<string, CellProblem>>>();
    for (const [id, found] of sheet.problems) map.set(id, found);
    return map;
  }, [sheet.problems]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid={testId}
      // The window's close guard asks before changes are lost.
      data-unsaved={dirty || undefined}
    >
      <PageHeader
        title={tn('repair.prices.title')}
        trail={trail}
        trailLabel={t('core.nav.trail')}
        actions={
          <>
            {dirty ? (
              <Button
                label={tn('repair.prices.sheet.discard')}
                variant="text"
                disabled={saving}
                onClick={() => setDiscarding(true)}
                data-testid={`${testId}.discard`}
              />
            ) : null}
            <Button
              label={
                saving
                  ? tn('repair.prices.sheet.saving', {
                      done: formatNumber(sheet.progress!.done),
                      total: formatNumber(sheet.progress!.total),
                    })
                  : dirty
                    ? tn('repair.prices.sheet.save', { count: formatNumber(sheet.changes) })
                    : tn('repair.prices.save')
              }
              variant="primary"
              busy={saving}
              disabled={!dirty}
              onClick={() => void sheet.save()}
              data-testid={`${testId}.save`}
            />
          </>
        }
      >
        {search}
      </PageHeader>
      {filters}
      {sheet.notice === null ? null : (
        <div className="px-6 pb-3">
          <Banner
            tone={sheet.blocked > 0 || sheet.refused.size > 0 ? 'warning' : 'success'}
            message={sheet.notice}
            onDismiss={sheet.clearNotice}
            dismissLabel={t('core.action.close')}
          />
        </div>
      )}
      {!sheet.loaded ? (
        <QueryPanel query={{ status: 'loading' }} onRetry={() => undefined}>
          {() => null}
        </QueryPanel>
      ) : (
        <EditableGrid
          columns={columns}
          rows={sheet.rows}
          onChange={sheet.setRows}
          newRow={newSheetRow}
          problems={problems}
          rowProblems={sheet.refused}
          disabled={saving}
          historyKey={sheet.saves}
          hint={tn('repair.prices.sheet.hint')}
          aside={
            sheet.blocked > 0 ? (
              <span className="font-semibold text-danger" data-testid={`${testId}.blocked`}>
                {tn('repair.prices.sheet.blocked', { count: formatNumber(sheet.blocked) })}
              </span>
            ) : undefined
          }
          labels={{
            row: (n) => tn('repair.prices.sheet.row', { n }),
            deleteRow: tn('repair.prices.sheet.deleteRow'),
            where: (n, column) => tn('repair.prices.sheet.where', { n, column }),
          }}
          label={tn('repair.prices.title')}
          testId={`${testId}.grid`}
        />
      )}
      <ConfirmDialog
        open={discarding}
        title={tn('repair.prices.discard.title')}
        message={tn('repair.prices.sheet.discardMessage')}
        confirmLabel={tn('repair.prices.discard.confirm')}
        cancelLabel={tn('repair.prices.discard.keep')}
        closeLabel={t('core.action.close')}
        destructive
        onConfirm={() => {
          setDiscarding(false);
          sheet.discard();
        }}
        onCancel={() => setDiscarding(false)}
        testId={`${testId}.discardConfirm`}
      />
      <ConfirmDialog
        open={leaving !== null}
        title={tn('repair.prices.discard.title')}
        message={tn('repair.prices.sheet.discardMessage')}
        confirmLabel={tn('repair.prices.discard.confirm')}
        cancelLabel={tn('repair.prices.discard.keep')}
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
