/**
 * RepairBoard — the store's repairs, search first. Typing searches every ticket with the fuzzy index
 * (name with Indonesian spelling tolerance, any phone format, ticket number, IMEI, model); with no
 * text the board shows one view of the queue. Technicians open on their own queue, everyone else on
 * all active repairs. A denied read is the Unauthorized state, never an empty board (FR-1036).
 */
import { formatDateTime, formatMoney, t, translateErrorCode } from '@bolusi/i18n';
import {
  AppShell,
  Button,
  Chip,
  List,
  SearchField,
  SegmentedControl,
  SyncStatusChip,
  border,
  color,
  space,
  touch,
  type,
  type ListState,
  type OperationSyncStatus,
} from '@bolusi/ui';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { TicketSummaryRow } from '../queries.js';
import { statusesFor, useSettledValue, type EntitySyncStatuses } from '../../screen-kit/index.js';

import { tn, type RepairKey } from '../i18n.js';
import {
  boardFilter,
  boardSort,
  boardViews,
  defaultBoardView,
  repairAbilities,
  ticketStatus,
  type BoardView,
} from '../flows.js';
import { statusLabel } from '../labels.js';
import { StatusChip, repairStyles } from './parts.js';
import { useRepairQuery, useRepairRuntime } from '../runtime.js';

const PAGE = 50;
/** Search is ranked, so its best matches come first and one page is enough. */
const SEARCH_LIMIT = 100;

const VIEW_KEY: Readonly<Record<BoardView, RepairKey>> = {
  active: 'repair.board.view.active',
  mine: 'repair.board.view.mine',
  unassigned: 'repair.board.view.unassigned',
  pickup: 'repair.board.view.pickup',
  returned: 'repair.board.view.returned',
  cancelled: 'repair.board.view.cancelled',
};

export interface RepairBoardProps {
  readonly syncChip: ReactNode;
  readonly avatar: ReactNode;
  readonly onOpenTicket: (ticketId: string) => void;
  readonly onNewIntake: () => void;
  readonly onOpenSyncStatus: () => void;
  readonly testID?: string | undefined;
}

interface LoadedBoard {
  readonly rows: readonly TicketSummaryRow[];
  readonly statuses: EntitySyncStatuses;
  readonly hasMore: boolean;
}

export function RepairBoard({
  syncChip,
  avatar,
  onOpenTicket,
  onNewIntake,
  onOpenSyncStatus,
  testID = 'repair.board',
}: RepairBoardProps): React.JSX.Element {
  const runtime = useRepairRuntime();
  const can = useMemo(() => repairAbilities(runtime.hasPermission), [runtime]);
  const [view, setView] = useState<BoardView>(() => defaultBoardView(can));
  const [text, setText] = useState('');
  const [pages, setPages] = useState(1);
  const [reloadNonce, setReloadNonce] = useState(0);
  // Search once the user pauses, not on every key; clearing the box shows the queue at once.
  const typed = text.trim();
  const settledText = useSettledValue(typed);
  const searchText = typed === '' ? '' : settledText;
  const searching = searchText !== '';

  const query = useRepairQuery<LoadedBoard>(
    async (rt) => {
      let rows: TicketSummaryRow[] = [];
      let hasMore = false;
      if (searching) {
        rows = [
          ...(await rt.query('searchTickets', { text: searchText, limit: SEARCH_LIMIT })).rows,
        ];
      } else {
        // Every page the user has scrolled to, re-read on each refresh so the live board stays whole.
        let cursor: string | null = null;
        for (let n = 0; n < pages; n += 1) {
          const page: {
            readonly rows: readonly TicketSummaryRow[];
            readonly nextCursor: string | null;
          } = await rt.query('listTickets', {
            filter: boardFilter(view, rt.userId),
            sort: boardSort(view),
            limit: PAGE,
            ...(cursor === null ? {} : { cursor }),
          });
          rows = [...rows, ...page.rows];
          cursor = page.nextCursor;
          if (cursor === null) break;
        }
        hasMore = cursor !== null;
      }
      const statuses = await rt.ticketSyncStatuses(rows.map((row) => row.id));
      return { rows, statuses, hasMore };
    },
    `board:${searching ? `q:${searchText}` : view}:${String(pages)}:${String(reloadNonce)}`,
  );

  // Recomputed only when the read settles, so typing re-renders the search box, not the list.
  const listState = useMemo((): ListState<TicketSummaryRow> => {
    switch (query.status) {
      case 'loading':
        return { kind: 'loading' };
      case 'unauthorized':
        return {
          kind: 'unauthorized',
          unauthorized: {
            title: t('core.errors.PERMISSION_DENIED'),
            hint: t('core.unauthorized.askOwner'),
            // A new grant arrives by sync, so the way forward is checking that this device is current.
            backLabel: tn('repair.board.checkSync'),
            onBack: onOpenSyncStatus,
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
            empty: {
              title: searching ? tn('repair.board.noMatches') : t('core.status.empty'),
              ...(searching ? {} : { hint: tn('repair.board.emptyHint') }),
            },
          };
        }
        return { kind: 'ready', items: query.data.rows };
    }
  }, [query, searching, onOpenSyncStatus]);

  const loaded = query.status === 'ready' ? query.data : null;
  const statuses = loaded?.statuses;
  const showCancel = !searching && view === 'cancelled';
  // The parent may pass new callbacks each render; rows keep one stable handler that calls the latest.
  const handlers = useRef({ onOpenTicket, onOpenSyncStatus });
  handlers.current = { onOpenTicket, onOpenSyncStatus };
  const openTicket = useCallback((id: string) => handlers.current.onOpenTicket(id), []);
  const openSyncStatus = useCallback(() => handlers.current.onOpenSyncStatus(), []);
  const renderRow = useCallback(
    (row: TicketSummaryRow) => (
      <TicketRow
        row={row}
        showCancel={showCancel}
        syncStatuses={statusesFor(statuses ?? {}, row.id)}
        onOpen={openTicket}
        onOpenSyncStatus={openSyncStatus}
        testID={`${testID}.row.${row.id}`}
        syncTestID={`${testID}.sync.${row.id}`}
      />
    ),
    [showCancel, statuses, openTicket, openSyncStatus, testID],
  );

  return (
    <AppShell
      title={tn('repair.board.title')}
      titleVariant="root"
      syncChip={syncChip}
      avatar={avatar}
      bottomAction={
        can.intake ? (
          <Button
            label={tn('repair.action.newIntake')}
            onPress={onNewIntake}
            testID={`${testID}.newIntake`}
          />
        ) : undefined
      }
      testID={testID}
    >
      <View style={styles.search}>
        <SearchField
          placeholder={tn('repair.board.searchHint')}
          accessibilityLabel={t('core.action.search')}
          clearLabel={tn('repair.board.clearSearch')}
          value={text}
          onChangeText={setText}
          testID={`${testID}.search`}
        />
      </View>
      {searching ? null : (
        <View style={styles.views}>
          <SegmentedControl
            options={boardViews(can).map((value) => ({ value, label: tn(VIEW_KEY[value]) }))}
            value={view}
            // One compact row that scrolls sideways and runs to the screen edges: the cut-off pill
            // at the edge shows there are more queues, and the list keeps the screen.
            size="compact"
            bleed
            onChange={(next) => {
              setView(next);
              setPages(1);
            }}
            testID={`${testID}.views`}
          />
        </View>
      )}

      <List
        // A new view or search starts at the top, not at the depth the last list was scrolled to.
        key={searching ? `q:${searchText}` : view}
        state={listState}
        keyExtractor={(row) => row.id}
        onEndReached={
          !searching && loaded?.hasMore === true
            ? () => setPages((current) => current + 1)
            : undefined
        }
        renderRow={renderRow}
        testID={`${testID}.items`}
      />
    </AppShell>
  );
}

interface TicketRowProps {
  readonly row: TicketSummaryRow;
  /** The owners' cancelled view: who cancelled, why, and a fee that differs from the store's. */
  readonly showCancel: boolean;
  readonly syncStatuses: readonly OperationSyncStatus[];
  readonly onOpen: (ticketId: string) => void;
  readonly onOpenSyncStatus: () => void;
  readonly testID: string;
  readonly syncTestID: string;
}

/**
 * Every live re-read brings new row objects, so rows compare by content: a change to one ticket
 * redraws that row only. Summary rows hold only primitives, so a shallow compare is exact.
 */
function sameRow(prev: TicketRowProps, next: TicketRowProps): boolean {
  const keys = Object.keys(next.row) as (keyof TicketSummaryRow)[];
  return (
    prev.showCancel === next.showCancel &&
    prev.onOpen === next.onOpen &&
    prev.onOpenSyncStatus === next.onOpenSyncStatus &&
    prev.testID === next.testID &&
    prev.syncTestID === next.syncTestID &&
    prev.syncStatuses.length === next.syncStatuses.length &&
    prev.syncStatuses.every((status, i) => status === next.syncStatuses[i]) &&
    keys.length === Object.keys(prev.row).length &&
    keys.every((key) => Object.is(prev.row[key], next.row[key]))
  );
}

/**
 * One repair on the board, readable at a glance: number and status, who it belongs to and what it
 * costs, the device and its technician, and a price change waiting on the counter. A plain list row
 * truncated all of that into one line.
 */
const TicketRow = memo(function TicketRow({
  row,
  showCancel,
  syncStatuses,
  onOpen,
  onOpenSyncStatus,
  testID,
  syncTestID,
}: TicketRowProps): React.JSX.Element {
  const device = [row.deviceBrand, row.deviceModel].filter((s) => s !== '').join(' ');
  const who = showCancel
    ? row.cancelledByName === null
      ? null
      : tn('repair.board.cancelledBy', { name: row.cancelledByName })
    : (row.technicianName ?? tn('repair.ticket.unassigned'));
  const details = [device, who].filter((s) => s !== null && s !== '').join(' · ');
  const reason = showCancel ? row.outcomeNote : null;
  // A cancelled servisan costs the customer its fee, never the repair price (none before fees).
  const amount = row.outcome === 'cancelled' ? (row.cancelFee ?? 0) : row.quoteTotal;
  const feeChanged =
    showCancel &&
    row.cancelFee !== null &&
    row.cancelStandardFee !== null &&
    row.cancelFee !== row.cancelStandardFee;
  // The label replaces what a screen reader would read from the row, so it says everything shown.
  const label = [
    row.ticketNumber,
    statusLabel(ticketStatus(row)),
    row.customerName,
    formatMoney(amount),
    details,
    reason ?? '',
    feeChanged ? tn('repair.board.feeChanged') : '',
    row.cancelledAt !== null && showCancel ? formatDateTime(row.cancelledAt) : '',
    row.pendingProposals > 0 ? tn('repair.board.priceChangeWaiting') : '',
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
      <View style={styles.rowBody}>
        <View style={repairStyles.row}>
          <Text style={[styles.customer, repairStyles.rowText]} numberOfLines={1}>
            {row.customerName}
          </Text>
          <Text style={styles.amount} testID={`${testID}.amount`}>
            {formatMoney(amount)}
          </Text>
        </View>
        <Text style={styles.details} numberOfLines={2}>
          {details}
        </Text>
        {reason === null || reason === '' ? null : (
          <Text style={styles.reason} numberOfLines={2} testID={`${testID}.reason`}>
            {reason}
          </Text>
        )}
        <View style={styles.footer}>
          <StatusChip status={ticketStatus(row)} testID={`${testID}.status`} />
          {feeChanged ? (
            <Chip
              label={tn('repair.board.feeChanged')}
              icon="warning"
              tone="warning"
              testID={`${testID}.feeChanged`}
            />
          ) : null}
          {row.pendingProposals > 0 ? (
            <Chip
              label={tn('repair.board.priceChangeWaiting')}
              icon="warning"
              tone="warning"
              testID={`${testID}.priceWaiting`}
            />
          ) : null}
          <SyncStatusChip
            syncStatuses={syncStatuses}
            pendingLabel={t('sync.chip.pending')}
            rejectedLabel={t('sync.chip.rejected')}
            onPressRejected={onOpenSyncStatus}
            testID={syncTestID}
          />
          <Text style={styles.number}>
            {showCancel && row.cancelledAt !== null
              ? `${formatDateTime(row.cancelledAt)} · ${row.ticketNumber}`
              : row.ticketNumber}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}, sameRow);

const styles = StyleSheet.create({
  search: { marginBottom: space.sm },
  views: { marginBottom: space.xs },
  row: {
    minHeight: touch.rowMin,
    // Rows run edge to edge so their dividers and pressed state span the screen, while their text
    // lines up with the search field above.
    marginHorizontal: -space.lg,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderBottomWidth: border.hairline,
    borderBottomColor: color.border,
  },
  rowBody: { flex: 1 },
  customer: { ...type.bodyBold, color: color.text },
  amount: { ...type.bodySm, fontWeight: '600', color: color.text, fontVariant: ['tabular-nums'] },
  details: { ...type.bodySm, color: color.textMuted },
  reason: { ...type.bodySm, color: color.text, marginTop: space.xs },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    flexWrap: 'wrap',
    marginTop: space.sm,
  },
  number: { ...type.caption, color: color.textMuted, marginLeft: 'auto' },
});
