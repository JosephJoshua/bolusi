/**
 * PartList — the business's parts with this store's stock, search first. Typing ranks every part by
 * fuzzy match on its name, code and the phones it fits; without text the list runs by name, a page
 * at a time, so thousands of parts stay quick. Stock below zero is flagged, and owners get a view of
 * just those to sort out.
 */
import { t, translateErrorCode } from '@bolusi/i18n';
import {
  AppShell,
  Button,
  List,
  SearchField,
  SegmentedControl,
  border,
  color,
  space,
  touch,
  type,
  type ListState,
} from '@bolusi/ui';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useSettledValue } from '../../screen-kit/index.js';
import type { ScreenChrome } from '../../screen-kit/screens/views.js';
import { INVENTORY_PERMISSION } from '../constants.js';
import { stockText } from '../labels.js';
import { ti, type InventoryKey } from '../i18n.js';
import type { PartFilter, PartRow } from '../queries.js';
import { useInventoryQuery, useInventoryRuntime } from '../runtime.js';

const PAGE = 50;

const FILTER_KEY: Readonly<Record<PartFilter, InventoryKey>> = {
  active: 'inventory.filter.active',
  belowZero: 'inventory.filter.belowZero',
  archived: 'inventory.filter.archived',
};

const EMPTY_KEY: Readonly<Record<PartFilter, InventoryKey>> = {
  active: 'inventory.list.emptyHint',
  belowZero: 'inventory.list.noBelowZero',
  archived: 'inventory.list.noArchived',
};

export interface PartListProps {
  readonly chrome: ScreenChrome;
  readonly onBack: () => void;
  readonly onOpenPart: (partId: string) => void;
  readonly onAddPart: () => void;
  readonly testID?: string | undefined;
}

interface LoadedParts {
  readonly rows: readonly PartRow[];
  readonly hasMore: boolean;
  readonly belowZero: number;
}

export function PartList({
  chrome,
  onBack,
  onOpenPart,
  onAddPart,
  testID = 'inventory.list',
}: PartListProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const canManage = runtime.hasPermission(INVENTORY_PERMISSION.manageParts);
  const [filter, setFilter] = useState<PartFilter>('active');
  const [text, setText] = useState('');
  const [pages, setPages] = useState(1);
  const [reloadNonce, setReloadNonce] = useState(0);
  const typed = text.trim();
  const settledText = useSettledValue(typed);
  const searchText = typed === '' ? '' : settledText;
  const searching = searchText !== '';

  const query = useInventoryQuery<LoadedParts>(
    async (rt) => {
      // Every page scrolled to, re-read on each refresh so the live list stays whole.
      let rows: PartRow[] = [];
      let next: string | null = '0';
      for (let n = 0; n < pages && next !== null; n += 1) {
        const page: { readonly rows: readonly PartRow[]; readonly nextCursor: string | null } =
          await rt.query('listParts', {
            text: searchText,
            filter: searching ? 'active' : filter,
            limit: PAGE,
            offset: Number(next),
          });
        rows = [...rows, ...page.rows];
        next = page.nextCursor;
      }
      const belowZero = (await rt.query('countBelowZero', {})).rows[0]?.count ?? 0;
      return { rows, hasMore: next !== null, belowZero };
    },
    `parts:${searching ? `q:${searchText}` : filter}:${String(pages)}:${String(reloadNonce)}`,
  );

  const listState = useMemo((): ListState<PartRow> => {
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
          return {
            kind: 'empty',
            empty: searching
              ? { title: ti('inventory.list.noMatches') }
              : filter === 'active'
                ? { title: t('core.status.empty'), hint: ti(EMPTY_KEY.active) }
                : { title: ti(EMPTY_KEY[filter]) },
          };
        }
        return { kind: 'ready', items: query.data.rows };
    }
  }, [query, searching, filter, onBack]);

  const loaded = query.status === 'ready' ? query.data : null;
  const belowZero = loaded?.belowZero ?? 0;
  // Owners sort out stock below zero; anyone else only sees the flag on the part itself.
  const filters: readonly PartFilter[] = canManage
    ? ['active', 'belowZero', 'archived']
    : ['active'];
  const openRef = useRef(onOpenPart);
  openRef.current = onOpenPart;
  const open = useCallback((id: string) => openRef.current(id), []);
  const renderRow = useCallback(
    (row: PartRow) => <PartListRow row={row} onOpen={open} testID={`${testID}.row.${row.id}`} />,
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
        <SearchField
          placeholder={ti('inventory.list.searchHint')}
          accessibilityLabel={t('core.action.search')}
          clearLabel={ti('inventory.list.clearSearch')}
          value={text}
          onChangeText={setText}
          testID={`${testID}.search`}
        />
      </View>
      {searching || filters.length === 1 ? null : (
        <View style={styles.filters}>
          <SegmentedControl
            options={filters.map((value) => ({
              value,
              label:
                value === 'belowZero' && belowZero > 0
                  ? `${ti(FILTER_KEY[value])} (${String(belowZero)})`
                  : ti(FILTER_KEY[value]),
            }))}
            value={filter}
            size="compact"
            bleed
            onChange={(next) => {
              setFilter(next);
              setPages(1);
            }}
            testID={`${testID}.filters`}
          />
        </View>
      )}
      <List
        key={searching ? `q:${searchText}` : filter}
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
  readonly row: PartRow;
  readonly onOpen: (partId: string) => void;
  readonly testID: string;
}

/** One part: its name, what it fits, and the store's stock on the right, flagged below zero. */
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
    (Object.keys(next.row) as (keyof PartRow)[]).every((key) =>
      Object.is(prev.row[key], next.row[key]),
    ),
);

const styles = StyleSheet.create({
  search: { marginBottom: space.sm },
  filters: { marginBottom: space.xs },
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
