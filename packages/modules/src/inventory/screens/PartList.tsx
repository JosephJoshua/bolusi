/**
 * PartList — the business's items with this store's stock, search first. Typing ranks every item by
 * fuzzy match on its name, codes, field values, tags and the phones it fits; without text the list
 * runs by name, a page at a time, so thousands of items stay quick. A scanned barcode or QR code
 * opens its item, and one row of chips narrows the list: the filters, then the categories. Stock
 * below zero is flagged, and owners get a chip for just those to sort out.
 */
import { t, translateErrorCode } from '@bolusi/i18n';
import {
  ActionChip,
  AppShell,
  Button,
  ChipRow,
  List,
  SearchField,
  ToggleChip,
  border,
  color,
  space,
  touch,
  type,
  type ListState,
  Text,
} from '@bolusi/ui';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useSettledValue } from '../../screen-kit/index.js';
import type { ScreenChrome } from '../../screen-kit/screens/views.js';
import { INVENTORY_PERMISSION } from '../constants.js';
import { stockText } from '../labels.js';
import { ti, type InventoryKey } from '../i18n.js';
import { NO_CATEGORY, type CategoryRow, type ItemRow, type PartFilter } from '../queries.js';
import { useInventoryQuery, useInventoryRuntime } from '../runtime.js';

const PAGE = 50;

/** What the list is narrowed to. The surface keeps it, so it outlives a trip into an item. */
export interface ListFilter {
  readonly stock: PartFilter;
  /** A category's id, `NO_CATEGORY`, or null for all. */
  readonly categoryId: string | null;
  readonly tags: readonly string[];
  /** By field id of the chosen category. */
  readonly values: Readonly<Record<string, readonly string[]>>;
}

export const NO_FILTER: ListFilter = { stock: 'active', categoryId: null, tags: [], values: {} };

/** How many filters are in force beyond the category, which shows in its own chips. */
export function filterCount(filter: ListFilter): number {
  return (
    (filter.stock === 'active' ? 0 : 1) +
    filter.tags.length +
    Object.values(filter.values).reduce((sum, values) => sum + values.length, 0)
  );
}

const EMPTY_KEY: Readonly<Record<PartFilter, InventoryKey>> = {
  active: 'inventory.list.emptyHint',
  belowZero: 'inventory.list.noBelowZero',
  outOfStock: 'inventory.list.noOutOfStock',
  archived: 'inventory.list.noArchived',
};

export interface PartListProps {
  readonly chrome: ScreenChrome;
  readonly filter: ListFilter;
  readonly onFilter: (filter: ListFilter) => void;
  readonly onOpenFilters: () => void;
  readonly onManageCategories: () => void;
  readonly onBack: () => void;
  readonly onOpenPart: (itemId: string) => void;
  readonly onAddPart: () => void;
  readonly testID?: string | undefined;
}

interface LoadedParts {
  readonly rows: readonly ItemRow[];
  readonly hasMore: boolean;
  readonly belowZero: number;
}

export function PartList({
  chrome,
  filter,
  onFilter,
  onOpenFilters,
  onManageCategories,
  onBack,
  onOpenPart,
  onAddPart,
  testID = 'inventory.list',
}: PartListProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const canManage = runtime.hasPermission(INVENTORY_PERMISSION.manageItems);
  const canSetUp = runtime.hasPermission(INVENTORY_PERMISSION.manageCategories);
  const [text, setText] = useState('');
  const [pages, setPages] = useState(1);
  const [reloadNonce, setReloadNonce] = useState(0);
  const typed = text.trim();
  const settledText = useSettledValue(typed);
  const searchText = typed === '' ? '' : settledText;
  const searching = searchText !== '';
  const filterKey = JSON.stringify(filter);
  const narrowed = filterCount(filter) > 0 || filter.categoryId !== null;

  const categories = useInventoryQuery<readonly CategoryRow[]>(
    async (rt) => (await rt.query('listCategories', {})).rows,
    'listCategories',
  );
  const query = useInventoryQuery<LoadedParts>(
    async (rt) => {
      // Every page scrolled to, re-read on each refresh so the live list stays whole.
      let rows: ItemRow[] = [];
      let next: string | null = '0';
      for (let n = 0; n < pages && next !== null; n += 1) {
        const page: { readonly rows: readonly ItemRow[]; readonly nextCursor: string | null } =
          await rt.query('listItems', {
            text: searchText,
            filter: filter.stock,
            categoryId: filter.categoryId,
            tags: [...filter.tags],
            values: Object.fromEntries(
              Object.entries(filter.values).map(([id, values]) => [id, [...values]]),
            ),
            limit: PAGE,
            offset: Number(next),
          });
        rows = [...rows, ...page.rows];
        next = page.nextCursor;
      }
      const belowZero = (await rt.query('countBelowZero', {})).rows[0]?.count ?? 0;
      return { rows, hasMore: next !== null, belowZero };
    },
    `parts:${searchText}:${filterKey}:${String(pages)}:${String(reloadNonce)}`,
  );

  const listState = useMemo((): ListState<ItemRow> => {
    switch (query.status) {
      case 'loading':
        return { kind: 'loading' };
      case 'unauthorized':
        return {
          kind: 'unauthorized',
          unauthorized: {
            title: t('core.errors.PERMISSION_DENIED'),
            hint: t('core.unauthorized.askOwner'),
            backLabel: t('core.action.back'),
            onBack,
          },
        };
      case 'error':
        return {
          kind: 'error',
          error: {
            title: translateErrorCode(query.code),
            errorCode: query.code,
            retryLabel: t('core.action.retry'),
            onRetry: () => setReloadNonce((current) => current + 1),
          },
        };
      case 'ready':
        if (query.data.rows.length === 0) {
          // Only a stock view picked: say what that view lacks.
          const onlyStock =
            filter.stock !== 'active' && filterCount(filter) === 1 && filter.categoryId === null;
          return {
            kind: 'empty',
            empty: searching
              ? { title: ti('inventory.list.noMatches') }
              : !narrowed
                ? { title: t('core.status.empty'), hint: ti(EMPTY_KEY.active) }
                : onlyStock
                  ? { title: ti(EMPTY_KEY[filter.stock]) }
                  : { title: ti('inventory.list.noFilterMatches') },
          };
        }
        return { kind: 'ready', items: query.data.rows };
    }
  }, [query, searching, narrowed, filter, onBack]);

  const loaded = query.status === 'ready' ? query.data : null;
  const belowZero = loaded?.belowZero ?? 0;
  const shownCategories = categories.status === 'ready' ? categories.data : [];
  const count = filterCount(filter);
  const update = (patch: Partial<ListFilter>): void => {
    setPages(1);
    onFilter({ ...filter, ...patch });
  };
  // Field values belong to a category's fields, so they go with it.
  const pickCategory = (categoryId: string | null): void => update({ categoryId, values: {} });

  // The categories as chips: all, each one, and none. The one picked comes first, beside the
  // filter, so a narrowed list always shows what it is narrowed to.
  const categoryChips: readonly { readonly id: string | null; readonly label: string }[] =
    shownCategories.length === 0
      ? []
      : [
          { id: null, label: ti('inventory.list.allCategories') },
          ...shownCategories.map((category) => ({ id: category.id, label: category.name })),
          { id: NO_CATEGORY, label: ti('inventory.list.noCategory') },
        ];
  const pickedChip =
    filter.categoryId === null
      ? undefined
      : categoryChips.find((chip) => chip.id === filter.categoryId);
  const categoryChip = (chip: (typeof categoryChips)[number]): React.JSX.Element => (
    <ToggleChip
      key={chip.id ?? 'all'}
      label={chip.label}
      selected={filter.categoryId === chip.id}
      onToggle={() => pickCategory(filter.categoryId === chip.id ? null : chip.id)}
      testID={`${testID}.category.${chip.id ?? 'all'}`}
    />
  );

  /** A code names one item: open it. Several, or none: search for it, which also shows near ones. */
  const scan = async (): Promise<void> => {
    const code = await runtime.scanCode?.();
    if (code === null || code === undefined || code.trim() === '') return;
    const found = await runtime
      .query('findByCode', { code })
      .then((page) => page.rows)
      .catch(() => []);
    if (found.length === 1 && found[0] !== undefined) onOpenPart(found[0].id);
    else setText(code.trim());
  };

  const openRef = useRef(onOpenPart);
  openRef.current = onOpenPart;
  const open = useCallback((id: string) => openRef.current(id), []);
  const renderRow = useCallback(
    (row: ItemRow) => <PartListRow row={row} onOpen={open} testID={`${testID}.row.${row.id}`} />,
    [open, testID],
  );

  return (
    <AppShell
      title={ti('inventory.list.title')}
      titleVariant="detail"
      onBack={onBack}
      backLabel={t('core.action.back')}
      syncChip={chrome.syncChip}
      avatar={chrome.avatar}
      bottomAction={
        canManage ? (
          <Button label={ti('inventory.action.add')} onPress={onAddPart} testID={`${testID}.add`} />
        ) : undefined
      }
      testID={testID}
    >
      <View style={styles.search}>
        <View style={styles.searchField}>
          <SearchField
            placeholder={ti('inventory.list.searchHint')}
            accessibilityLabel={t('core.action.search')}
            clearLabel={ti('inventory.list.clearSearch')}
            value={text}
            onChangeText={setText}
            testID={`${testID}.search`}
          />
        </View>
        {runtime.scanCode === undefined ? null : (
          <ActionChip
            label={ti('inventory.list.scan')}
            icon="scan"
            onPress={() => void scan()}
            testID={`${testID}.scan`}
          />
        )}
      </View>
      <View style={styles.chips}>
        <ChipRow testID={`${testID}.chips`}>
          <ActionChip
            label={
              count === 0
                ? ti('inventory.list.filter')
                : ti('inventory.list.filterCount', { count: String(count) })
            }
            icon="filter"
            active={count > 0}
            onPress={onOpenFilters}
            testID={`${testID}.filter`}
          />
          {pickedChip === undefined ? null : categoryChip(pickedChip)}
          {canManage && (belowZero > 0 || filter.stock === 'belowZero') ? (
            <ToggleChip
              label={`${ti('inventory.filter.belowZero')} (${String(belowZero)})`}
              selected={filter.stock === 'belowZero'}
              onToggle={() =>
                update({ stock: filter.stock === 'belowZero' ? 'active' : 'belowZero' })
              }
              testID={`${testID}.belowZero`}
            />
          ) : null}
          {categoryChips.filter((chip) => chip !== pickedChip).map(categoryChip)}
          {canSetUp ? (
            <ActionChip
              label={ti('inventory.list.manageCategories')}
              icon="settings"
              onPress={onManageCategories}
              testID={`${testID}.categories`}
            />
          ) : null}
        </ChipRow>
      </View>
      <List
        key={`${searchText}:${filterKey}`}
        state={listState}
        keyExtractor={(row) => row.id}
        onEndReached={loaded?.hasMore === true ? () => setPages((n) => n + 1) : undefined}
        renderRow={renderRow}
        testID={`${testID}.items`}
      />
    </AppShell>
  );
}

interface PartListRowProps {
  readonly row: ItemRow;
  readonly onOpen: (itemId: string) => void;
  readonly testID: string;
}

/** One item: its name, what it fits, and the store's stock on the right, flagged below zero. */
const PartListRow = memo(
  function PartListRow({ row, onOpen, testID }: PartListRowProps): React.JSX.Element {
    const details = [row.code, row.fits].filter((s) => s !== null && s !== '').join(' · ');
    const below = row.onHand < 0;
    const label = [
      row.name,
      details,
      ti('inventory.list.stockCount', { count: stockText(row.onHand) }),
      below ? ti('inventory.list.belowZero') : '',
      row.archived ? ti('inventory.list.archived') : '',
    ]
      .filter((s) => s !== '')
      .join(', ');
    return (
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={() => onOpen(row.id)}
        android_ripple={{ color: color.surfaceAlt }}
        style={({ pressed }) => [
          styles.row,
          { backgroundColor: pressed ? color.surfaceAlt : color.surface },
        ]}
      >
        <View style={styles.rowText}>
          <Text style={styles.name} numberOfLines={2}>
            {row.name}
          </Text>
          {details === '' ? null : (
            <Text style={styles.details} numberOfLines={1}>
              {details}
            </Text>
          )}
        </View>
        <View style={styles.stock}>
          <Text style={[styles.count, below ? styles.countBelow : null]} testID={`${testID}.stock`}>
            {stockText(row.onHand)}
          </Text>
          <Text style={styles.stockLabel}>{ti('inventory.list.stock')}</Text>
        </View>
      </Pressable>
    );
  },
  (prev, next) =>
    prev.onOpen === next.onOpen &&
    prev.testID === next.testID &&
    (Object.keys(next.row) as (keyof ItemRow)[]).every((key) =>
      Object.is(prev.row[key], next.row[key]),
    ),
);

const styles = StyleSheet.create({
  search: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm },
  searchField: { flex: 1 },
  chips: { marginBottom: space.xs },
  row: {
    minHeight: touch.rowMin,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: -space.lg,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderBottomWidth: border.hairline,
    borderBottomColor: color.border,
  },
  rowText: { flex: 1 },
  name: { ...type.bodyBold, color: color.text },
  details: { ...type.bodySm, color: color.textMuted, marginTop: space.xs },
  stock: { alignItems: 'flex-end', flexShrink: 0 },
  count: { ...type.heading, color: color.text, fontVariant: ['tabular-nums'] },
  countBelow: { color: color.danger },
  stockLabel: { ...type.caption, color: color.textMuted },
});
