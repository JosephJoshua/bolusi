// Perlu dicek on the counter PC: the requests an owner or Manajer may answer, oldest first, as a
// table with the servisan open beside it on its answer; and what else waits on them across the
// store, as buttons that open the page where it is worked off. Only what has something in it shows.
import { formatRelative, t } from '@bolusi/i18n';
import { Button, DataTable, PageHeader, StatePanel, type ColumnDef } from '@bolusi/ui-web';
import { Ban, Clock, ClipboardCheck, Package, ShoppingCart, type LucideIcon } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

import { approvalKindKey, ta } from '../../approvals/i18n.js';
import { QueryPanel } from '../../screen-kit/desktop/index.js';
import { useTick } from '../../screen-kit/index.js';
import { describeRepairApproval } from '../approval-copy.js';
import {
  ATTENTION_COUNTS,
  ATTENTION_COUNT_KEY,
  attentionCount,
  attentionEmpty,
  readAttention,
  type AttentionCount,
  type AttentionRequest,
} from '../attention.js';
import { UNCOLLECTED_REFRESH_MS } from '../flows.js';
import { tn } from '../i18n.js';
import { useRepairQuery } from '../runtime.js';
import type { IntakeDraft } from '../flows.js';
import { TwoLines } from './parts.js';
import { TicketPane } from './TicketPane.js';

const ICON: Readonly<Record<AttentionCount, LucideIcon>> = {
  uncollected: Clock,
  belowZero: Package,
  partlyReceived: ShoppingCart,
  refused: Ban,
};

export interface AttentionPageProps {
  readonly now: () => number;
  /** This person's own changes the server refused, still to be looked at. */
  readonly refused: number;
  readonly onOpenList: (list: AttentionCount) => void;
  readonly onOpenSyncStatus?: (() => void) | undefined;
  readonly onStartClaim?: ((draft: IntakeDraft) => void) | undefined;
}

/** The servisan open beside the table, and the request it was opened on. */
interface Open {
  readonly ticketId: string;
  readonly requestId: string;
}

export function AttentionPage({
  now,
  refused,
  onOpenList,
  onOpenSyncStatus,
  onStartClaim,
}: AttentionPageProps): React.JSX.Element {
  const [reloadNonce, setReloadNonce] = useState(0);
  const hour = useTick(UNCOLLECTED_REFRESH_MS);
  const query = useRepairQuery(
    (rt) => readAttention(rt, now()),
    `desk.attention:${String(reloadNonce)}:${String(hour)}`,
  );
  const [open, setOpen] = useState<Open | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const loaded = query.status === 'ready' ? query.data : null;
  const readAt = now();
  const columns = useMemo(() => requestColumns(readAt), [readAt]);

  const lists =
    loaded === null
      ? []
      : ATTENTION_COUNTS.map((key) => ({
          key,
          count: attentionCount(key, loaded, refused),
        })).filter((list) => list.count > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="repair.desk.attention">
      <PageHeader title={tn('repair.attention.title')} />
      <div className="flex min-h-0 flex-1 flex-col @container">
        <div
          className={
            open === null
              ? 'relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]'
              : 'relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] @[960px]:grid-cols-[minmax(0,1fr)_clamp(400px,38%,600px)]'
          }
        >
          <div className="flex min-h-0 min-w-0 flex-col gap-4">
            {query.status !== 'ready' ? (
              <QueryPanel query={query} onRetry={() => setReloadNonce((n) => n + 1)}>
                {() => null}
              </QueryPanel>
            ) : attentionEmpty(query.data, refused) ? (
              <StatePanel
                icon={ClipboardCheck}
                title={tn('repair.attention.empty')}
                hint={tn('repair.attention.emptyHint')}
                testId="repair.desk.attention.empty"
              />
            ) : (
              <>
                {lists.length === 0 ? null : (
                  <nav
                    aria-label={tn('repair.attention.elsewhere')}
                    className="flex flex-wrap gap-2 px-6"
                    data-testid="repair.desk.attention.lists"
                  >
                    {lists.map((list) => (
                      <Button
                        key={list.key}
                        label={`${tn(ATTENTION_COUNT_KEY[list.key])} (${String(list.count)})`}
                        icon={ICON[list.key]}
                        onClick={() => onOpenList(list.key)}
                        data-testid={`repair.desk.attention.list.${list.key}`}
                      />
                    ))}
                  </nav>
                )}
                {query.data.requests.length === 0 ? null : (
                  <section className="flex min-h-0 flex-1 flex-col gap-2">
                    <h2 className="px-6 text-heading font-semibold text-text">
                      {tn('repair.attention.requests', { count: query.data.requests.length })}
                    </h2>
                    <DataTable
                      rows={query.data.requests}
                      columns={columns}
                      getRowId={(row) => row.request.id}
                      selectedId={open?.requestId ?? null}
                      onSelect={(row) =>
                        setOpen({ ticketId: row.request.targetId, requestId: row.request.id })
                      }
                      bodyRef={tableRef}
                      sortable={false}
                      label={tn('repair.attention.title')}
                      testId="repair.desk.attention.requests"
                    />
                  </section>
                )}
              </>
            )}
          </div>
          {open === null ? null : (
            <div className="absolute inset-0 z-10 flex animate-pane-in flex-col @[960px]:static">
              <TicketPane
                // A fresh pane per request: it opens on that request's answer.
                key={open.requestId}
                ticketId={open.ticketId}
                answerRequestId={open.requestId}
                now={now}
                onClose={() => {
                  setOpen(null);
                  tableRef.current?.focus();
                }}
                onOpenSyncStatus={onOpenSyncStatus}
                onStartClaim={onStartClaim}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function requestColumns(readAt: number): ColumnDef<AttentionRequest, unknown>[] {
  return [
    {
      id: 'request',
      header: tn('repair.attention.col.request'),
      meta: { track: 'minmax(200px, 2fr)' },
      cell: ({ row: { original: row } }) => {
        const description = describeRepairApproval(row.request);
        return (
          <TwoLines
            first={[ta(approvalKindKey(row.request.kind)), description.amount]
              .filter((part) => part !== null)
              .join(' · ')}
            second={description.title}
            strong
          />
        );
      },
    },
    {
      id: 'ticket',
      header: tn('repair.attention.col.ticket'),
      meta: { track: 'minmax(200px, 2fr)' },
      cell: ({ row: { original: row } }) => (
        <TwoLines
          first={
            row.ticket === null
              ? t('core.errors.NOT_ON_DEVICE')
              : `${row.ticket.ticketNumber} · ${row.ticket.customerName}`
          }
          second={
            row.ticket === null
              ? ''
              : [row.ticket.deviceBrand, row.ticket.deviceModel].filter((s) => s !== '').join(' ')
          }
        />
      ),
    },
    {
      id: 'asked',
      header: tn('repair.attention.col.asked'),
      meta: { track: 'minmax(200px, 2fr)', fold: 2 },
      cell: ({ row: { original: row } }) => (
        <TwoLines
          first={ta('approvals.row.askedBy', {
            name: row.request.requestedByName ?? '–',
            reason: row.request.reason,
          })}
          second={formatRelative(Math.max(0, readAt - row.request.requestedAt))}
        />
      ),
    },
  ];
}
