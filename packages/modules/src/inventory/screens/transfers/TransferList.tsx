/**
 * TransferList — parts this store sent to another store or was sent: the ones still open (on the
 * way, partly arrived, or needing a check) or all of them. Each row says which store, how much has
 * arrived and its stage.
 */
import { formatDate, t, translateErrorCode } from '@bolusi/i18n';
import {
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
} from '@bolusi/ui';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { PlaceHeader, ScreenChrome } from '../../../screen-kit/screens/views.js';
import { INVENTORY_PERMISSION } from '../../constants.js';
import { ti } from '../../i18n.js';
import { useInventoryQuery, useInventoryRuntime } from '../../runtime.js';
import {
  TRANSFER_STAGE_CHIP,
  otherStoreText,
  transferProgress,
  type StoreChoice,
} from '../../transfers/form.js';
import type { TransferFilter, TransferRow } from '../../transfers/queries.js';
import { useStores } from '../../transfers/stores.js';

export interface TransferListProps {
  readonly chrome: ScreenChrome;
  readonly filter: TransferFilter;
  readonly onFilter: (filter: TransferFilter) => void;
  /** The Barang place's title and the switch to its other sections. */
  readonly place: PlaceHeader;
  readonly onOpen: (transferId: string) => void;
  readonly onSend: () => void;
  /** The transfer open beside the list on a wide screen: its row is marked, "Kirim" steps back. */
  readonly selectedId?: string | null | undefined;
  readonly testID?: string | undefined;
}

export function TransferList({
  chrome,
  filter,
  onFilter,
  place,
  onOpen,
  onSend,
  selectedId = null,
  testID = 'inventory.transfers',
}: TransferListProps): React.JSX.Element {
  const runtime = useInventoryRuntime();
  const canSend = runtime.hasPermission(INVENTORY_PERMISSION.transfer);
  const stores = useStores();
  const [reloadNonce, setReloadNonce] = useState(0);
  const query = useInventoryQuery(
    async (rt) => (await rt.query('listTransfers', { filter })).rows,
    `transfers:${filter}:${String(reloadNonce)}`,
  );

  const listState = useMemo((): ListState<TransferRow> => {
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
            onRetry: () => setReloadNonce((n) => n + 1),
          },
        };
      case 'ready':
        return query.data.length === 0
          ? {
              kind: 'empty',
              empty: {
                title: ti(
                  filter === 'open'
                    ? 'inventory.transfer.list.emptyOpen'
                    : 'inventory.transfer.list.emptyAll',
                ),
              },
            }
          : { kind: 'ready', items: query.data };
    }
  }, [query, filter, place.onOpenSyncStatus]);

  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const open = useCallback((id: string) => openRef.current(id), []);
  const renderRow = useCallback(
    (row: TransferRow) => (
      <TransferListRow
        row={row}
        stores={stores}
        selected={row.id === selectedId}
        onOpen={open}
        testID={`${testID}.row.${row.id}`}
      />
    ),
    [open, selectedId, stores, testID],
  );

  return (
    <AppShell
      title={place.title}
      syncChip={chrome.syncChip}
      avatar={chrome.avatar}
      bottomAction={
        canSend ? (
          <Button
            label={ti('inventory.transfer.list.new')}
            variant={selectedId === null ? 'primary' : 'secondary'}
            onPress={onSend}
            testID={`${testID}.new`}
          />
        ) : undefined
      }
      testID={testID}
    >
      {place.sections}
      <View style={styles.chips}>
        <ChipRow testID={`${testID}.chips`}>
          <ToggleChip
            label={ti('inventory.transfer.list.open')}
            selected={filter === 'open'}
            onToggle={() => onFilter('open')}
            testID={`${testID}.filter.open`}
          />
          <ToggleChip
            label={ti('inventory.transfer.list.all')}
            selected={filter === 'all'}
            onToggle={() => onFilter('all')}
            testID={`${testID}.filter.all`}
          />
        </ChipRow>
      </View>
      <List
        key={filter}
        state={listState}
        keyExtractor={(row) => row.id}
        renderRow={renderRow}
        edgeToEdge
        testID={`${testID}.list`}
      />
    </AppShell>
  );
}

interface TransferListRowProps {
  readonly row: TransferRow;
  readonly stores: readonly StoreChoice[];
  readonly selected: boolean;
  readonly onOpen: (transferId: string) => void;
  readonly testID: string;
}

const TransferListRow = memo(function TransferListRow({
  row,
  stores,
  selected,
  onOpen,
  testID,
}: TransferListRowProps): React.JSX.Element {
  const stage = TRANSFER_STAGE_CHIP[row.stage];
  const stageLabel = ti(`inventory.transfer.stage.${row.stage}`);
  const store = otherStoreText(row, stores);
  const meta = `${row.transferNumber} · ${formatDate(row.sentAt)}`;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={[store, stageLabel, transferProgress(row), meta].join(', ')}
      accessibilityState={{ selected }}
      onPress={() => onOpen(row.id)}
      android_ripple={{ color: color.surfaceAlt }}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? color.surfaceAlt : selected ? color.infoBg : color.surface },
      ]}
    >
      <View style={styles.rowTop}>
        <Text style={styles.name}>{store}</Text>
        <Chip label={stageLabel} icon={stage.icon} tone={stage.tone} />
      </View>
      <Text style={styles.details}>{transferProgress(row)}</Text>
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
    gap: space.xs,
  },
  // A stage chip that does not fit beside the store moves under it, never squeezing either.
  rowTop: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  name: { ...type.bodyBold, color: color.text, flexShrink: 1 },
  details: { ...type.bodySm, color: color.text },
  meta: { ...type.caption, color: color.textMuted },
});
