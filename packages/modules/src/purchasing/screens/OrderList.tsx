/**
 * OrderList — this store's orders to suppliers: the ones still running (drafts, and orders waiting
 * on parts) or the ones done. Each row says who it is from, how far it has arrived and its stage.
 */
import { formatDate, t, translateErrorCode } from '@bolusi/i18n';
import {
  ActionChip,
  AppShell,
  Button,
  Chip,
  ChipRow,
  List,
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

import type { ScreenChrome } from '../../screen-kit/screens/views.js';
import { tp } from '../i18n.js';
import { STAGE_CHIP } from '../order-form.js';
import type { OrderFilter, OrderRow } from '../queries.js';
import { loadOrderPages, usePurchasingQuery } from '../runtime.js';

const PAGE = 50;

export interface OrderListProps {
  readonly chrome: ScreenChrome;
  readonly filter: OrderFilter;
  readonly onFilter: (filter: OrderFilter) => void;
  readonly onBack: () => void;
  readonly onOpenOrder: (orderId: string) => void;
  readonly onNewOrder: () => void;
  readonly onOpenSuppliers: () => void;
  readonly testID?: string | undefined;
}

export function OrderList({
  chrome,
  filter,
  onFilter,
  onBack,
  onOpenOrder,
  onNewOrder,
  onOpenSuppliers,
  testID = 'purchasing.orders',
}: OrderListProps): React.JSX.Element {
  const [pages, setPages] = useState(1);
  const [reloadNonce, setReloadNonce] = useState(0);
  const query = usePurchasingQuery(
    async (rt) => {
      return loadOrderPages(rt, filter, pages, PAGE);
    },
    `orders:${filter}:${String(pages)}:${String(reloadNonce)}`,
  );

  const listState = useMemo((): ListState<OrderRow> => {
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
            onRetry: () => setReloadNonce((n) => n + 1),
          },
        };
      case 'ready':
        return query.data.rows.length === 0
          ? {
              kind: 'empty',
              empty: {
                title: tp(
                  filter === 'open' ? 'purchasing.list.emptyOpen' : 'purchasing.list.emptyDone',
                ),
              },
            }
          : { kind: 'ready', items: query.data.rows };
    }
  }, [query, filter, onBack]);

  const openRef = useRef(onOpenOrder);
  openRef.current = onOpenOrder;
  const open = useCallback((id: string) => openRef.current(id), []);
  const renderRow = useCallback(
    (row: OrderRow) => <OrderListRow row={row} onOpen={open} testID={`${testID}.row.${row.id}`} />,
    [open, testID],
  );
  const pick = (next: OrderFilter): void => {
    setPages(1);
    onFilter(next);
  };

  return (
    <AppShell
      title={tp('purchasing.list.title')}
      titleVariant="detail"
      onBack={onBack}
      backLabel={t('core.action.back')}
      syncChip={chrome.syncChip}
      avatar={chrome.avatar}
      bottomAction={
        // Offline with the orders not on this device, a new one could not pick a supplier either.
        query.status === 'error' && query.code === 'NOT_ON_DEVICE' ? undefined : (
          <Button label={tp('purchasing.list.new')} onPress={onNewOrder} testID={`${testID}.new`} />
        )
      }
      testID={testID}
    >
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
        keyExtractor={(row) => row.id}
        onEndReached={
          query.status === 'ready' && query.data.hasMore ? () => setPages((n) => n + 1) : undefined
        }
        renderRow={renderRow}
        testID={`${testID}.list`}
      />
    </AppShell>
  );
}

/** "Dipesan · 2 dari 5 diterima": how far an order has come, in one line. */
export function orderProgress(row: OrderRow): string {
  const parts = tp('purchasing.list.parts', { count: row.lineCount });
  if (row.stage === 'draft' || row.stage === 'ordered') return parts;
  return `${parts} · ${tp('purchasing.list.progress', { received: row.receivedQty, ordered: row.orderedQty })}`;
}

interface OrderListRowProps {
  readonly row: OrderRow;
  readonly onOpen: (orderId: string) => void;
  readonly testID: string;
}

const OrderListRow = memo(function OrderListRow({
  row,
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
      onPress={() => onOpen(row.id)}
      android_ripple={{ color: color.surfaceAlt }}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? color.surfaceAlt : color.surface },
      ]}
    >
      <View style={styles.rowTop}>
        <Text style={styles.name} numberOfLines={2}>
          {row.supplierName}
        </Text>
        <Chip label={tp(`purchasing.stage.${row.stage}`)} icon={stage.icon} tone={stage.tone} />
      </View>
      <Text style={styles.details}>{orderProgress(row)}</Text>
      <Text style={styles.meta}>{meta}</Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  chips: { marginBottom: space.xs },
  row: {
    minHeight: touch.rowMin,
    marginHorizontal: -space.lg,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderBottomWidth: border.hairline,
    borderBottomColor: color.border,
    gap: space.xs,
  },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  name: { ...type.bodyBold, color: color.text, flex: 1 },
  details: { ...type.bodySm, color: color.text },
  meta: { ...type.caption, color: color.textMuted },
});
