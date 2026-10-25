/**
 * RepairBoard — the store's repairs, search first. Typing searches every ticket with the fuzzy index
 * (name with Indonesian spelling tolerance, any phone format, ticket number, IMEI, model); with no
 * text the board shows one view of the queue. Technicians open on their own queue, everyone else on
 * all active repairs. A denied read is the Unauthorized state, never an empty board (FR-1036).
 */
import { formatMoney, t, translateErrorCode } from '@bolusi/i18n';
import {
  AppShell,
  Button,
  List,
  ListRow,
  SegmentedControl,
  SyncStatusChip,
  TextInput,
  space,
  type ListState,
} from '@bolusi/ui';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import type { TicketSummaryRow } from '../queries.js';
import { statusesFor, type EntitySyncStatuses } from '../../screen-kit/index.js';

import { tn, type RepairKey } from './i18n.js';
import {
  BOARD_VIEWS,
  boardFilter,
  defaultBoardView,
  repairAbilities,
  ticketStatus,
  type BoardView,
} from '../flows.js';
import { statusLabel } from './labels.js';
import { useRepairQuery, useRepairRuntime } from './runtime.js';

const PAGE = 50;
const MAX_PAGE = 100;

const VIEW_KEY: Readonly<Record<BoardView, RepairKey>> = {
  active: 'repair.board.view.active',
  mine: 'repair.board.view.mine',
  unassigned: 'repair.board.view.unassigned',
  pickup: 'repair.board.view.pickup',
  returned: 'repair.board.view.returned',
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
  const [limit, setLimit] = useState(PAGE);
  const [reloadNonce, setReloadNonce] = useState(0);
  const searching = text.trim() !== '';

  const query = useRepairQuery<LoadedBoard>(
    async (rt) => {
      const page = searching
        ? await rt.query('searchTickets', { text: text.trim(), limit: MAX_PAGE })
        : await rt.query('listTickets', { filter: boardFilter(view, rt.userId), limit });
      const statuses = await rt.ticketSyncStatuses(page.rows.map((row) => row.id));
      return { rows: page.rows, statuses, hasMore: page.nextCursor !== null };
    },
    `board:${searching ? `q:${text.trim()}` : view}:${String(limit)}:${String(reloadNonce)}`,
  );

  const listState = ((): ListState<TicketSummaryRow> => {
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
  })();

  const loaded = query.status === 'ready' ? query.data : null;

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
      <View style={styles.toolbar}>
        <TextInput
          label={t('core.action.search')}
          placeholder={tn('repair.board.searchHint')}
          value={text}
          onChangeText={setText}
          testID={`${testID}.search`}
        />
      </View>
      {searching ? null : (
        <View style={styles.toolbar}>
          <SegmentedControl
            options={BOARD_VIEWS.map((value) => ({ value, label: tn(VIEW_KEY[value]) }))}
            value={view}
            onChange={(next) => {
              setView(next);
              setLimit(PAGE);
            }}
            testID={`${testID}.views`}
          />
        </View>
      )}

      <List
        state={listState}
        keyExtractor={(row) => row.id}
        onEndReached={
          !searching && loaded?.hasMore === true && limit < MAX_PAGE
            ? () => setLimit((current) => Math.min(current + PAGE, MAX_PAGE))
            : undefined
        }
        renderRow={(row) => (
          <ListRow
            primaryText={`${row.ticketNumber} · ${row.customerName}`}
            secondaryText={secondaryFor(row)}
            trailing={
              <SyncStatusChip
                syncStatuses={statusesFor(loaded?.statuses ?? {}, row.id)}
                pendingLabel={t('sync.chip.pending')}
                rejectedLabel={t('sync.chip.rejected')}
                onPressRejected={onOpenSyncStatus}
                testID={`${testID}.sync.${row.id}`}
              />
            }
            onPress={() => onOpenTicket(row.id)}
            showChevron
            testID={`${testID}.row.${row.id}`}
          />
        )}
        testID={`${testID}.items`}
      />
    </AppShell>
  );
}

/** "Samsung Galaxy A14 · In repair · Budi" with a waiting price change called out. */
function secondaryFor(row: TicketSummaryRow): string {
  const parts = [
    `${row.deviceBrand} ${row.deviceModel}`,
    statusLabel(ticketStatus(row)),
    row.technicianName ?? tn('repair.ticket.unassigned'),
    formatMoney(row.quoteTotal),
  ];
  if (row.pendingProposals > 0) parts.push(tn('repair.board.priceChangeWaiting'));
  return parts.join(' · ');
}

const styles = StyleSheet.create({
  toolbar: { marginBottom: space.md },
});
