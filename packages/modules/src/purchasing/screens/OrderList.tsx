/**
 * OrderList — this store's orders to suppliers: the ones still running (drafts, and orders waiting
 * on parts) or the ones done. Each row says who it is from, how far it has arrived and its stage.
 */
import { formatDate, formatMoney, t, translateErrorCode } from '@bolusi/i18n';
import {
  ActionChip,
  Amount,
  AppShell,
  Button,
  Chip,
  ChipRow,
  List,
  ToggleChip,
  color,
  space,
  touch,
  type,
  type ListState,
  Text,
  ValueText,
} from '@bolusi/ui';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { PlaceHeader, ScreenChrome } from '../../screen-kit/screens/views.js';
import { opensBills } from '../constants.js';
import { tp } from '../i18n.js';
import { STAGE_CHIP } from '../order-form.js';
import type { OrderRow } from '../queries.js';
import { dueText, notaText, type BelanjaTab } from '../bills/bill-form.js';
import type { BillRow } from '../bills/queries.js';
import {
  loadBillPages,
  loadOrderPages,
  usePurchasingQuery,
  usePurchasingRuntime,
} from '../runtime.js';

const PAGE = 50;

export interface OrderListProps {
  readonly chrome: ScreenChrome;
  readonly filter: BelanjaTab;
  readonly onFilter: (filter: BelanjaTab) => void;
  /** The Barang place's title and the switch to its other sections. */
  readonly place: PlaceHeader;
  readonly onOpenOrder: (orderId: string) => void;
  readonly onNewOrder: () => void;
  readonly onOpenBill: (billId: string) => void;
  readonly onNewBill: () => void;
  readonly onOpenSuppliers: () => void;
  /**
   * The order open beside the list on a wide screen: its row is marked, and a new order steps back
   * to an outlined button so the open order's next step is the one filled action on screen.
   */
  readonly selectedId?: string | null | undefined;
  readonly testID?: string | undefined;
}

export function OrderList({
  chrome,
  filter,
  onFilter,
  place,
  onOpenOrder,
  onNewOrder,
  onOpenBill,
  onNewBill,
  onOpenSuppliers,
  selectedId = null,
  testID = 'purchasing.orders',
}: OrderListProps): React.JSX.Element {
  const runtime = usePurchasingRuntime();
  const bills = opensBills(runtime) && filter === 'bills';
  const [pages, setPages] = useState(1);
  const [reloadNonce, setReloadNonce] = useState(0);
  const query = usePurchasingQuery(
    async (rt): Promise<{ readonly rows: readonly ListedRow[]; readonly hasMore: boolean }> => {
      if (bills) {
        const page = await loadBillPages(rt, pages, PAGE);
        return {
          rows: page.rows.map((row) => ({ kind: 'bill' as const, row })),
          hasMore: page.hasMore,
        };
      }
      const page = await loadOrderPages(rt, filter === 'bills' ? 'open' : filter, pages, PAGE);
      return {
        rows: page.rows.map((row) => ({ kind: 'order' as const, row })),
        hasMore: page.hasMore,
      };
    },
    `orders:${filter}:${String(bills)}:${String(pages)}:${String(reloadNonce)}`,
  );

  const listState = useMemo((): ListState<ListedRow> => {
    switch (query.status) {
      case 'loading':
        return { kind: 'loading' };
      case 'unauthorized':
        return {
          kind: 'unauthorized',
          unauthorized: {
            title: t('core.errors.PERMISSION_DENIED'),
            hint: t('core.unauthorized.askOwner'),
            // A new grant arrives by sync, so the way forward is checking this device is current.
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
            onRetry: () => setReloadNonce((n) => n + 1),
          },
        };
      case 'ready':
        return query.data.rows.length === 0
          ? {
              kind: 'empty',
              empty: {
                title: tp(
                  bills
                    ? 'purchasing.bill.listEmpty'
                    : filter === 'done'
                      ? 'purchasing.list.emptyDone'
                      : 'purchasing.list.emptyOpen',
                ),
              },
            }
          : { kind: 'ready', items: query.data.rows };
    }
  }, [query, filter, bills, place.onOpenSyncStatus]);

  const openRef = useRef(onOpenOrder);
  openRef.current = onOpenOrder;
  const open = useCallback((id: string) => openRef.current(id), []);
  const openBillRef = useRef(onOpenBill);
  openBillRef.current = onOpenBill;
  const openBill = useCallback((id: string) => openBillRef.current(id), []);
  const renderRow = useCallback(
    (listed: ListedRow) =>
      listed.kind === 'order' ? (
        <OrderListRow
          row={listed.row}
          selected={listed.row.id === selectedId}
          onOpen={open}
          testID={`${testID}.row.${listed.row.id}`}
        />
      ) : (
        <BillListRow
          row={listed.row}
          selected={listed.row.id === selectedId}
          onOpen={openBill}
          testID={`${testID}.bill.${listed.row.id}`}
        />
      ),
    [open, openBill, selectedId, testID],
  );
  const pick = (next: BelanjaTab): void => {
    setPages(1);
    onFilter(next);
  };

  return (
    <AppShell
      title={place.title}
      syncChip={chrome.syncChip}
      avatar={chrome.avatar}
      bottomAction={
        // Offline with the orders not on this device, a new one could not pick a supplier either.
        query.status === 'error' && query.code === 'NOT_ON_DEVICE' ? undefined : (
          <Button
            label={tp(bills ? 'purchasing.bill.new' : 'purchasing.list.new')}
            variant={selectedId === null ? 'primary' : 'secondary'}
            onPress={bills ? onNewBill : onNewOrder}
            testID={bills ? `${testID}.newBill` : `${testID}.new`}
          />
        )
      }
      testID={testID}
    >
      {place.sections}
      <View style={styles.chips}>
        <ChipRow testID={`${testID}.chips`}>
          <ToggleChip
            label={tp('purchasing.list.open')}
            selected={filter === 'open'}
            onToggle={() => pick('open')}
            testID={`${testID}.filter.open`}
          />
          <ToggleChip
            label={tp('purchasing.list.done')}
            selected={filter === 'done'}
            onToggle={() => pick('done')}
            testID={`${testID}.filter.done`}
          />
          {opensBills(runtime) ? (
            <ToggleChip
              label={tp('purchasing.bill.tab')}
              selected={bills}
              onToggle={() => pick('bills')}
              testID={`${testID}.filter.bills`}
            />
          ) : null}
          <ActionChip
            label={tp('purchasing.supplier.listTitle')}
            icon="store"
            onPress={onOpenSuppliers}
            testID={`${testID}.suppliers`}
          />
        </ChipRow>
      </View>
      <List
        key={filter}
        state={listState}
        keyExtractor={(listed) => listed.row.id}
        onEndReached={
          query.status === 'ready' && query.data.hasMore ? () => setPages((n) => n + 1) : undefined
        }
        renderRow={renderRow}
        edgeToEdge
        testID={`${testID}.list`}
      />
    </AppShell>
  );
}

type ListedRow =
  | { readonly kind: 'order'; readonly row: OrderRow }
  | { readonly kind: 'bill'; readonly row: BillRow };

/** "Dipesan · 2 dari 5 diterima": how far an order has come, in one line. */
export function orderProgress(row: OrderRow): string {
  const parts = tp('purchasing.list.parts', { count: row.lineCount });
  if (row.stage === 'draft' || row.stage === 'ordered') return parts;
  return `${parts} · ${tp('purchasing.list.progress', { received: row.receivedQty, ordered: row.orderedQty })}`;
}

interface OrderListRowProps {
  readonly row: OrderRow;
  /** Open beside the list on a wide screen. */
  readonly selected: boolean;
  readonly onOpen: (orderId: string) => void;
  readonly testID: string;
}

const OrderListRow = memo(function OrderListRow({
  row,
  selected,
  onOpen,
  testID,
}: OrderListRowProps): React.JSX.Element {
  const stage = STAGE_CHIP[row.stage];
  const meta = `${row.orderNumber} · ${formatDate(row.orderedAt ?? row.createdAt)}`;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={[
        row.supplierName,
        tp(`purchasing.stage.${row.stage}`),
        orderProgress(row),
        meta,
      ].join(', ')}
      accessibilityState={{ selected }}
      onPress={() => onOpen(row.id)}
      android_ripple={{ color: color.surfaceAlt }}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? color.surfaceAlt : selected ? color.infoBg : color.surface },
      ]}
    >
      <View style={styles.rowTop}>
        <ValueText lines={2} style={styles.name}>
          {row.supplierName}
        </ValueText>
        <Chip label={tp(`purchasing.stage.${row.stage}`)} icon={stage.icon} tone={stage.tone} />
      </View>
      <Text style={styles.details}>{orderProgress(row)}</Text>
      <Text style={styles.meta}>{meta}</Text>
    </Pressable>
  );
});

interface BillListRowProps {
  readonly row: BillRow;
  readonly selected: boolean;
  readonly onOpen: (billId: string) => void;
  readonly testID: string;
}

/** A bill in the list: whose, its total, its nota and when it is due. */
const BillListRow = memo(function BillListRow({
  row,
  selected,
  onOpen,
  testID,
}: BillListRowProps): React.JSX.Element {
  const voided = row.status === 'void';
  const meta = `${row.billNumber} · ${notaText(row)}`;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={[
        row.supplierName,
        formatMoney(row.total),
        voided ? tp('purchasing.bill.statusVoid') : dueText(row),
        meta,
      ].join(', ')}
      accessibilityState={{ selected }}
      onPress={() => onOpen(row.id)}
      android_ripple={{ color: color.surfaceAlt }}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? color.surfaceAlt : selected ? color.infoBg : color.surface },
      ]}
    >
      <View style={styles.rowTop}>
        <ValueText lines={2} style={styles.name}>
          {row.supplierName}
        </ValueText>
        <Amount value={row.total} tone={voided ? 'struck' : 'text'} />
      </View>
      {voided ? (
        <View style={styles.chipLine}>
          <Chip label={tp('purchasing.bill.statusVoid')} icon="remove" tone="neutral" />
        </View>
      ) : (
        <Text style={styles.details}>{dueText(row)}</Text>
      )}
      <Text style={styles.meta}>{meta}</Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  chipLine: { flexDirection: 'row' },
  chips: { marginBottom: space.xs },
  row: {
    minHeight: touch.rowMin,
    marginHorizontal: -space.lg,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    gap: space.xs,
  },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  name: { ...type.bodyBold, color: color.text, flex: 1 },
  details: { ...type.bodySm, color: color.text },
  meta: { ...type.caption, color: color.textMuted },
});
