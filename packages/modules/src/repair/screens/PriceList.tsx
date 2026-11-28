/**
 * PriceList — the business's repair prices with what this store charges, phone first: typing ranks
 * every row by how well its phones match ("redmi not 10" finds the Redmi Note 10), and one row of
 * chips narrows it to a repair type. The counter answers "berapa ganti LCD A12?" from here without
 * starting an intake. The owner adds and changes rows from the same list.
 */
import { formatMoney, t, translateErrorCode } from '@bolusi/i18n';
import {
  AppShell,
  Banner,
  Button,
  ChipRow,
  color,
  List,
  type ListState,
  numeric,
  SearchField,
  space,
  Text,
  ToggleChip,
  touch,
  type,
} from '@bolusi/ui';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useSettledValue } from '../../screen-kit/index.js';
import type { PlaceHeader, ScreenChrome } from '../../screen-kit/screens/views.js';
import { tn } from '../i18n.js';
import {
  priceAbilities,
  priceModelsText,
  priceTitle,
  priceTypeLabel,
  usePriceTypes,
  type PriceType,
} from '../price-list.js';
import type { PriceRow } from '../prices.queries.js';
import { useRepairQuery, useRepairRuntime } from '../runtime.js';

const PAGE = 50;

export interface PriceListProps {
  readonly chrome: ScreenChrome;
  /** The Servisan place's title and the switch to its other section. */
  readonly place: PlaceHeader;
  /** What the last save did ("Harga Ganti LCD · Ori disimpan."); null for nothing to say. */
  readonly notice?: string | null | undefined;
  readonly onClearNotice?: (() => void) | undefined;
  readonly onOpenPrice: (row: PriceRow) => void;
  readonly onAddPrice: () => void;
  readonly testID?: string | undefined;
}

interface LoadedPrices {
  readonly rows: readonly PriceRow[];
  readonly hasMore: boolean;
}

export function PriceList({
  chrome,
  place,
  notice = null,
  onClearNotice,
  onOpenPrice,
  onAddPrice,
  testID = 'repair.prices',
}: PriceListProps): React.JSX.Element {
  const runtime = useRepairRuntime();
  const can = useMemo(() => priceAbilities(runtime.hasPermission), [runtime]);
  const types = usePriceTypes(can.edit ? 'business' : 'store');
  const [text, setText] = useState('');
  const [repairType, setRepairType] = useState<string | null>(null);
  const [pages, setPages] = useState(1);
  const [reloadNonce, setReloadNonce] = useState(0);
  const typed = text.trim();
  const settledText = useSettledValue(typed);
  const searchText = typed === '' ? '' : settledText;

  const query = useRepairQuery<LoadedPrices>(
    async (rt) => {
      // Every page scrolled to, re-read on each refresh so the live list stays whole.
      let rows: PriceRow[] = [];
      let next: string | null = '0';
      for (let n = 0; n < pages && next !== null; n += 1) {
        const page: { readonly rows: readonly PriceRow[]; readonly nextCursor: string | null } =
          await rt.query('priceList', {
            text: searchText,
            repairType,
            offset: Number(next),
            limit: PAGE,
          });
        rows = [...rows, ...page.rows];
        next = page.nextCursor;
      }
      return { rows, hasMore: next !== null };
    },
    `prices:${searchText}:${repairType ?? ''}:${String(pages)}:${String(reloadNonce)}`,
  );

  const narrowed = searchText !== '' || repairType !== null;
  const listState = useMemo((): ListState<PriceRow> => {
    switch (query.status) {
      case 'loading':
        return { kind: 'loading' };
      case 'unauthorized':
        return {
          kind: 'unauthorized',
          unauthorized: {
            title: t('core.errors.PERMISSION_DENIED'),
            hint: t('core.unauthorized.askOwner'),
            backLabel: t('sync.status.screenTitle'),
            onBack: place.onOpenSyncStatus,
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
            empty: narrowed
              ? { title: tn('repair.prices.noMatches') }
              : {
                  title: tn('repair.prices.empty'),
                  hint: tn(can.edit ? 'repair.prices.emptyOwnerHint' : 'repair.prices.emptyHint'),
                },
          };
        }
        return { kind: 'ready', items: query.data.rows };
    }
  }, [query, narrowed, can.edit, place.onOpenSyncStatus]);

  const loaded = query.status === 'ready' ? query.data : null;
  const opens = can.edit || can.store;
  const openRef = useRef(onOpenPrice);
  openRef.current = onOpenPrice;
  const open = useCallback((row: PriceRow) => openRef.current(row), []);
  const renderRow = useCallback(
    (row: PriceRow) => (
      <PriceListRow
        row={row}
        types={types}
        showsStore={can.store}
        onOpen={opens ? open : undefined}
        testID={`${testID}.row.${row.id}`}
      />
    ),
    [types, can.store, opens, open, testID],
  );

  const pick = (id: string | null): void => {
    setPages(1);
    setRepairType(id);
  };

  return (
    <AppShell
      title={place.title}
      titleVariant="root"
      syncChip={chrome.syncChip}
      avatar={chrome.avatar}
      banner={
        notice === null ? undefined : (
          <Banner
            variant="info"
            message={notice}
            onPress={onClearNotice}
            testID={`${testID}.notice`}
          />
        )
      }
      bottomAction={
        can.edit ? (
          <Button label={tn('repair.prices.add')} onPress={onAddPrice} testID={`${testID}.add`} />
        ) : undefined
      }
      testID={testID}
    >
      {place.sections}
      <View style={styles.search}>
        <SearchField
          placeholder={tn('repair.prices.searchHint')}
          accessibilityLabel={t('core.action.search')}
          clearLabel={tn('repair.board.clearSearch')}
          value={text}
          onChangeText={(next) => {
            setPages(1);
            setText(next);
          }}
          testID={`${testID}.search`}
        />
      </View>
      {types === null || types.length === 0 ? null : (
        <View style={styles.chips}>
          <ChipRow testID={`${testID}.types`}>
            <ToggleChip
              label={tn('repair.prices.allTypes')}
              selected={repairType === null}
              onToggle={() => pick(null)}
              testID={`${testID}.type.all`}
            />
            {types.map((type) => (
              <ToggleChip
                key={type.id}
                label={type.label}
                selected={repairType === type.id}
                onToggle={() => pick(repairType === type.id ? null : type.id)}
                testID={`${testID}.type.${type.id}`}
              />
            ))}
          </ChipRow>
        </View>
      )}
      <List
        key={`${searchText}:${repairType ?? ''}`}
        state={listState}
        keyExtractor={(row) => row.id}
        onEndReached={loaded?.hasMore === true ? () => setPages((n) => n + 1) : undefined}
        renderRow={renderRow}
        edgeToEdge
        testID={`${testID}.items`}
      />
    </AppShell>
  );
}

interface PriceListRowProps {
  readonly row: PriceRow;
  readonly types: readonly PriceType[] | null;
  /** The person sets this store's prices: a row priced apart says so. */
  readonly showsStore: boolean;
  /** Absent for whoever only reads the list: the row is then not a button. */
  readonly onOpen: ((row: PriceRow) => void) | undefined;
  readonly testID: string;
}

/** One row: the repair and quality, the phones it covers, and what this store charges. */
const PriceListRow = memo(function PriceListRow({
  row,
  types,
  showsStore,
  onOpen,
  testID,
}: PriceListRowProps): React.JSX.Element {
  const title = priceTitle(priceTypeLabel(types, row.repairType), row.quality);
  const models = priceModelsText(row.models);
  const storePriced = showsStore && row.storeAmount !== null;
  const body = (
    <>
      <View style={styles.rowText}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.models}>{models}</Text>
      </View>
      <View style={styles.amount}>
        <Text style={styles.price} testID={`${testID}.amount`}>
          {formatMoney(row.amount)}
        </Text>
        {storePriced ? (
          <Text style={styles.priceNote} testID={`${testID}.storePrice`}>
            {tn('repair.prices.storePriced')}
          </Text>
        ) : null}
      </View>
    </>
  );
  const label = [title, models, formatMoney(row.amount)].join(', ');
  if (onOpen === undefined) {
    return (
      <View style={styles.row} accessible accessibilityLabel={label} testID={testID}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => onOpen(row)}
      android_ripple={{ color: color.surfaceAlt }}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? color.surfaceAlt : color.surface },
      ]}
    >
      {body}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  search: { marginBottom: space.sm },
  chips: { marginBottom: space.xs },
  row: {
    minHeight: touch.rowMin,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    marginHorizontal: -space.lg,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    backgroundColor: color.surface,
  },
  rowText: { flex: 1 },
  title: { ...type.bodyBold, color: color.text },
  models: { ...type.bodySm, color: color.textMuted, marginTop: space.xs },
  amount: { alignItems: 'flex-end', flexShrink: 0 },
  price: { ...type.bodyBold, color: color.text, ...numeric },
  priceNote: { ...type.caption, color: color.textMuted, marginTop: space.xs },
});
