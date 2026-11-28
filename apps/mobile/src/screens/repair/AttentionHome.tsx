/**
 * AttentionHome — Perlu dicek at the shell's first tab, for whoever may answer requests. Each row
 * opens where the work is done: a request on its servisan's answer, phones not collected on the
 * board's queue, stock below zero and orders partly in under Barang, refused changes in Sync
 * Status. The shell takes the person there, and back brings them here again.
 */
import type { ItemsOpenTarget } from '../inventory/ItemsHome.js';
import type { RepairOpenTarget } from './RepairHome.js';
import {
  AttentionList,
  RepairRuntimeProvider,
  type AttentionCount,
  type RepairRuntime,
} from '@bolusi/modules/repair/screens';
import type { ReactNode } from 'react';

/** Where a row of Perlu dicek leads. */
export type AttentionTarget =
  | { readonly place: 'repair'; readonly open: RepairOpenTarget }
  | { readonly place: 'items'; readonly open: ItemsOpenTarget }
  | { readonly place: 'syncStatus' };

const LIST_TARGET: Readonly<Record<AttentionCount, AttentionTarget>> = {
  uncollected: { place: 'repair', open: { kind: 'board', view: 'uncollected' } },
  belowZero: { place: 'items', open: { section: 'stock', stock: 'belowZero' } },
  partlyReceived: { place: 'items', open: { section: 'orders', orders: 'open' } },
  refused: { place: 'syncStatus' },
};

export interface AttentionHomeProps {
  readonly runtime: RepairRuntime;
  readonly now: () => number;
  readonly refused: number;
  readonly syncChip: ReactNode;
  readonly avatar: ReactNode;
  readonly onOpen: (target: AttentionTarget) => void;
  readonly onOpenSyncStatus: () => void;
}

export function AttentionHome({
  runtime,
  now,
  refused,
  syncChip,
  avatar,
  onOpen,
  onOpenSyncStatus,
}: AttentionHomeProps): React.JSX.Element {
  return (
    <RepairRuntimeProvider runtime={runtime}>
      <AttentionList
        chrome={{ syncChip, avatar }}
        now={now}
        refused={refused}
        onOpenRequest={({ request }) =>
          onOpen({
            place: 'repair',
            open: { kind: 'request', ticketId: request.targetId, requestId: request.id },
          })
        }
        onOpenList={(list) => onOpen(LIST_TARGET[list])}
        onOpenSyncStatus={onOpenSyncStatus}
      />
    </RepairRuntimeProvider>
  );
}
