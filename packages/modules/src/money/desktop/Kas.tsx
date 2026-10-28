/**
 * Kas on the counter PC: the phone's board (money/screens/Kas.tsx) in a desktop layout over the
 * same reads (`useKasDay`). Hari ini shows the drawer and what came in on the left, and who still
 * owes or is owed on the right; Riwayat lists a day's records, where an owner cancels a payment.
 * Each task opens as a dialog over the page.
 */
import { formatDate, formatDateTime, formatMoney, formatTime } from '@bolusi/i18n';
import {
  Button,
  Card,
  DataTable,
  OverflowText,
  PageHeader,
  RollingText,
  Section,
  StatePanel,
  Tabs,
  type ColumnDef,
} from '@bolusi/ui-web';
import { ArrowDownUp, ChevronLeft, ChevronRight, Inbox, ReceiptText } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { QueryPanel } from '../../screen-kit/desktop/index.js';

import { MONEY_PERMISSION } from '../constants.js';
import { shiftDay, useDayRecords } from '../day-records.js';
import { tm } from '../i18n.js';
import {
  accountLabel,
  dayStart,
  differenceText,
  historyLine,
  voidable,
  type NamedBalance,
} from '../kas.js';
import { useKasDay } from '../kas-day.js';
import type { CashCountRow, MoneyEntryRow, PaymentAccountRow } from '../queries.js';
import { useMoneyRuntime } from '../runtime.js';

import {
  CountCashDialog,
  MoveCashDialog,
  ReceiveDebtDialog,
  SettleCountDialog,
  VoidPaymentDialog,
} from './KasDialogs.js';

type KasTab = 'today' | 'history';

type Task =
  | { readonly kind: 'count' }
  | { readonly kind: 'move' }
  | { readonly kind: 'settle'; readonly count: CashCountRow }
  | { readonly kind: 'receive'; readonly balance: NamedBalance }
  | {
      readonly kind: 'void';
      readonly entry: MoneyEntryRow;
      readonly accounts: readonly PaymentAccountRow[];
    };

export interface KasPageProps {
  readonly now: () => number;
}

export function KasPage({ now }: KasPageProps): React.JSX.Element {
  const day = useKasDay(now);
  const { may } = day;
  const [tab, setTab] = useState<KasTab>('today');
  const [task, setTask] = useState<Task | null>(null);
  // The day Riwayat shows; null for today, so a page left open overnight moves on with the clock.
  const [historyDay, setHistoryDay] = useState<number | null>(null);
  const close = (): void => setTask(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="money.desk.kas">
      <PageHeader
        title={tm('money.kas.title')}
        actions={
          <>
            {may.move ? (
              <Button
                label={tm('money.kas.move')}
                icon={ArrowDownUp}
                onClick={() => setTask({ kind: 'move' })}
                data-testid="money.desk.kas.move"
              />
            ) : null}
            {may.count ? (
              <Button
                label={tm('money.kas.count')}
                variant="primary"
                onClick={() => setTask({ kind: 'count' })}
                data-testid="money.desk.kas.count"
              />
            ) : null}
          </>
        }
      />
      {may.read ? (
        <div className="px-6">
          <Tabs
            items={[
              { value: 'today', label: tm('money.history.today') },
              { value: 'history', label: tm('money.history.open') },
            ]}
            value={tab}
            onChange={setTab}
            label={tm('money.kas.title')}
            testId="money.desk.kas.tabs"
          />
        </div>
      ) : null}
      {tab === 'history' && may.read ? (
        <History
          now={now}
          day={historyDay}
          onDay={setHistoryDay}
          onVoid={(entry, accounts) => setTask({ kind: 'void', entry, accounts })}
        />
      ) : (
        <Today
          day={day}
          onSettle={(count) => setTask({ kind: 'settle', count })}
          onReceive={(balance) => setTask({ kind: 'receive', balance })}
        />
      )}

      {task?.kind === 'count' ? <CountCashDialog onDone={close} onClose={close} /> : null}
      {task?.kind === 'move' ? <MoveCashDialog onDone={close} onClose={close} /> : null}
      {task?.kind === 'settle' ? (
        <SettleCountDialog count={task.count} onDone={close} onClose={close} />
      ) : null}
      {task?.kind === 'receive' ? (
        <ReceiveDebtDialog balance={task.balance} onDone={close} onClose={close} />
      ) : null}
      {task?.kind === 'void' ? (
        <VoidPaymentDialog
          entry={task.entry}
          accounts={task.accounts}
          onDone={close}
          onClose={close}
        />
      ) : null}
    </div>
  );
}

// ── Hari ini ───────────────────────────────────────────────────────────────────────────────────

function Today({
  day,
  onSettle,
  onReceive,
}: {
  readonly day: ReturnType<typeof useKasDay>;
  readonly onSettle: (count: CashCountRow) => void;
  readonly onReceive: (balance: NamedBalance) => void;
}): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const { drawerQuery, drawer, accounts, entriesReady, methods, moves, open, difference, counted } =
    day;
  const { may } = day;
  const testId = 'money.desk.kas';

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto px-6 py-6 @container"
      data-testid={`${testId}.today`}
    >
      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 items-start gap-6 @[900px]:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
          <QueryPanel query={drawerQuery} onRetry={day.retry}>
            {() =>
              drawer === null ? null : (
                <Card testId={`${testId}.drawer`}>
                  <p className="text-body text-text-muted">{tm('money.kas.expected')}</p>
                  <p
                    className="tabular mt-1 text-display font-bold text-text"
                    data-testid={`${testId}.expected`}
                  >
                    <RollingText value={drawer.expected}>
                      {formatMoney(drawer.expected)}
                    </RollingText>
                  </p>
                  <p className="mt-1 text-body text-text-muted" data-testid={`${testId}.lastCount`}>
                    {counted === null
                      ? tm('money.kas.notCounted')
                      : tm('money.kas.counted', { time: formatTime(counted.countedAt) })}
                  </p>
                </Card>
              )
            }
          </QueryPanel>

          {difference === null ? null : (
            <Section title={tm('money.kas.difference')} testId={`${testId}.differences`}>
              <Card>
                {/* The difference leads; when and by whom under it, so a narrow column wraps
                    neither. */}
                <div
                  className="flex items-center gap-4"
                  data-testid={`${testId}.difference.${difference.id}`}
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span
                      className={[
                        'tabular text-heading font-semibold',
                        difference.difference < 0 ? 'text-danger' : 'text-text',
                      ].join(' ')}
                      data-testid={`${testId}.difference.${difference.id}.value`}
                    >
                      {differenceText(difference.difference)}
                    </span>
                    <span className="break-words text-small text-text-muted">
                      {[formatDateTime(difference.countedAt), runtime.nameOf(difference.countedBy)]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </div>
                  {may.settle ? (
                    <Button
                      label={tm('money.kas.settle')}
                      size="sm"
                      onClick={() => onSettle(difference)}
                      data-testid={`${testId}.settle`}
                    />
                  ) : (
                    <span className="shrink-0 text-small text-text-muted">
                      {tm('money.kas.waitingOwner')}
                    </span>
                  )}
                </div>
              </Card>
            </Section>
          )}

          {entriesReady ? (
            <Section title={tm('money.kas.inToday')} testId={`${testId}.in`}>
              <Card>
                {methods.length === 0 ? (
                  <p className="text-body text-text-muted">{tm('money.kas.nothingIn')}</p>
                ) : (
                  <>
                    {methods.map((method) => (
                      <Line
                        key={method.account}
                        label={accountLabel(method.account, accounts)}
                        value={formatMoney(method.amount)}
                        testId={`${testId}.in.${method.account}`}
                      />
                    ))}
                    <Line
                      label={tm('money.kas.total')}
                      value={formatMoney(methods.reduce((sum, method) => sum + method.amount, 0))}
                      strong
                      testId={`${testId}.in.total`}
                    />
                  </>
                )}
              </Card>
            </Section>
          ) : null}

          {moves.length === 0 ? null : (
            <Section title={tm('money.kas.movesToday')} testId={`${testId}.moves`}>
              <Card>
                {moves.map(({ entry, label, delta }) => (
                  <Line
                    key={entry.id}
                    label={tm(label)}
                    detail={[formatTime(entry.createdAt), entry.reason].filter(Boolean).join(' · ')}
                    value={`${delta < 0 ? '−' : '+'}${formatMoney(Math.abs(delta))}`}
                    testId={`${testId}.moves.${entry.id}`}
                  />
                ))}
              </Card>
            </Section>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <Section title={tm('money.kas.owed')} testId={`${testId}.owed`}>
            <Card>
              {open.owed.length === 0 ? (
                <p className="text-body text-text-muted">{tm('money.kas.nothingOwed')}</p>
              ) : (
                open.owed.map((row) => (
                  <Line
                    key={row.documentId}
                    label={row.customer ?? row.documentLabel}
                    detail={[
                      row.customer === null ? null : row.documentLabel,
                      tm('money.kas.since', { date: formatDate(row.since) }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    value={formatMoney(row.balance)}
                    action={
                      may.receive ? (
                        <Button
                          label={tm('money.kas.receive')}
                          size="sm"
                          onClick={() => onReceive(row)}
                          data-testid={`${testId}.owed.${row.documentId}.receive`}
                        />
                      ) : undefined
                    }
                    testId={`${testId}.owed.${row.documentId}`}
                  />
                ))
              )}
            </Card>
          </Section>

          {open.owedBack.length === 0 ? null : (
            <Section title={tm('money.kas.owedBack')} testId={`${testId}.owedBack`}>
              <Card>
                <p className="pb-2 text-small text-text-muted">{tm('money.kas.owedBackHint')}</p>
                {open.owedBack.map((row) => (
                  <Line
                    key={row.documentId}
                    label={row.customer ?? row.documentLabel}
                    detail={row.customer === null ? undefined : row.documentLabel}
                    value={formatMoney(-row.balance)}
                    testId={`${testId}.owedBack.${row.documentId}`}
                  />
                ))}
              </Card>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

/** A label (and a line under it) left, its amount right, and the one action on it. */
function Line({
  label,
  detail,
  value,
  strong = false,
  action,
  testId,
}: {
  readonly label: string;
  readonly detail?: string | undefined;
  readonly value: string;
  readonly strong?: boolean | undefined;
  readonly action?: ReactNode;
  readonly testId: string;
}): React.JSX.Element {
  return (
    <div
      className={[
        'flex min-h-11 items-center gap-4 py-2',
        strong ? 'pt-3' : 'border-b border-border last:border-b-0',
      ].join(' ')}
      data-testid={testId}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className={
            strong ? 'text-body font-semibold text-text' : 'break-words text-body text-text'
          }
        >
          {label}
        </span>
        {detail === undefined || detail === '' ? null : (
          <span className="break-words text-small text-text-muted">{detail}</span>
        )}
      </div>
      <span
        className="tabular whitespace-nowrap text-body font-semibold text-text"
        data-testid={`${testId}.value`}
      >
        {value}
      </span>
      {action === undefined ? null : <div className="flex shrink-0 justify-end">{action}</div>}
    </div>
  );
}

// ── Riwayat ────────────────────────────────────────────────────────────────────────────────────

function History({
  now,
  day: chosen,
  onDay,
  onVoid,
}: {
  readonly now: () => number;
  readonly day: number | null;
  readonly onDay: (day: number | null) => void;
  readonly onVoid: (entry: MoneyEntryRow, accounts: readonly PaymentAccountRow[]) => void;
}): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const mayVoid = runtime.hasPermission(MONEY_PERMISSION.voidPayment);
  const [pages, setPages] = useState(1);
  const [nonce, setNonce] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const today = dayStart(now());
  const day = chosen ?? today;
  const records = useDayRecords(day, pages, nonce);
  const loaded = records.status === 'ready' ? records.data : null;
  const testId = 'money.desk.history';

  const goTo = (next: number): void => {
    setPages(1);
    setSelected(null);
    onDay(next >= today ? null : next);
  };

  const columns = useMemo((): ColumnDef<MoneyEntryRow, unknown>[] => {
    // Each record as Riwayat reads it, worked out once for its cells.
    const lines = new Map(
      (loaded?.rows ?? []).map((entry) => [
        entry.id,
        historyLine(
          entry,
          loaded?.accounts ?? [],
          entry.documentId === null ? null : (loaded?.customers.get(entry.documentId) ?? null),
        ),
      ]),
    );
    const lineOf = (entry: MoneyEntryRow) => lines.get(entry.id) ?? historyLine(entry, []);
    const accounts = loaded?.accounts ?? [];
    return [
      {
        id: 'time',
        accessorFn: (row) => row.createdAt,
        header: tm('money.history.col.time'),
        meta: { track: '72px' },
        cell: ({ row: { original: entry } }) => (
          <span className="tabular text-body text-text-muted">{formatTime(entry.createdAt)}</span>
        ),
      },
      {
        id: 'record',
        header: tm('money.history.col.record'),
        meta: { track: 'minmax(240px, 1fr)' },
        cell: ({ row: { original: entry } }) => {
          const line = lineOf(entry);
          return (
            <span className="block min-w-0">
              <span className={line.voided ? 'text-body text-text-muted' : 'text-body text-text'}>
                {tm(line.label)}
              </span>
              {line.details.length === 0 ? null : (
                <OverflowText
                  text={line.details.join(' · ')}
                  className="text-small text-text-muted"
                />
              )}
            </span>
          );
        },
      },
      {
        id: 'amount',
        header: tm('money.pay.amount'),
        meta: { track: '136px', align: 'end' },
        cell: ({ row: { original: entry } }) => {
          const line = lineOf(entry);
          return (
            <span
              className={
                line.voided
                  ? 'tabular text-body text-text-muted line-through'
                  : 'tabular text-body font-semibold text-text'
              }
            >
              {line.amount}
            </span>
          );
        },
      },
      ...(mayVoid
        ? [
            {
              id: 'action',
              header: '',
              meta: { track: '112px', align: 'end' as const },
              cell: ({ row: { original: entry } }: { row: { original: MoneyEntryRow } }) =>
                voidable(entry) ? (
                  <Button
                    label={tm('money.history.void')}
                    aria-label={tm('money.history.voidLabel', {
                      amount: formatMoney(entry.amount),
                      time: formatTime(entry.createdAt),
                    })}
                    variant="dangerText"
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation();
                      onVoid(entry, accounts);
                    }}
                    data-testid={`${testId}.void.${entry.id}`}
                  />
                ) : null,
            } satisfies ColumnDef<MoneyEntryRow, unknown>,
          ]
        : []),
    ];
  }, [loaded, mayVoid, onVoid]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid={testId}>
      <div className="flex h-14 items-center gap-2 px-6">
        <Button
          label={tm('money.history.previousDay')}
          icon={ChevronLeft}
          variant="text"
          size="sm"
          onClick={() => goTo(shiftDay(day, -1))}
          data-testid={`${testId}.previous`}
        />
        <span
          className="min-w-40 text-center text-body font-semibold text-text"
          data-testid={`${testId}.day`}
        >
          {day === today ? tm('money.history.today') : formatDate(day)}
        </span>
        <Button
          label={tm('money.history.nextDay')}
          icon={ChevronRight}
          variant="text"
          size="sm"
          onClick={() => goTo(shiftDay(day, 1))}
          disabled={day >= today}
          data-testid={`${testId}.next`}
        />
        {day === today ? null : (
          <Button
            label={tm('money.history.today')}
            size="sm"
            onClick={() => goTo(today)}
            data-testid={`${testId}.today`}
          />
        )}
      </div>
      {records.status === 'unauthorized' || records.status === 'error' ? (
        <QueryPanel query={records} onRetry={() => setNonce((n) => n + 1)}>
          {() => null}
        </QueryPanel>
      ) : (
        <DataTable
          rows={loaded?.rows ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          selectedId={selected}
          onSelect={(row) => setSelected(row.id)}
          onActivate={(row) => {
            if (mayVoid && voidable(row)) onVoid(row, loaded?.accounts ?? []);
          }}
          // Newest first, as the query reads them across pages.
          sortable={false}
          scrollKey={String(day)}
          onEndReached={loaded?.more === true ? () => setPages((n) => n + 1) : undefined}
          loading={records.status === 'loading'}
          empty={
            <StatePanel
              icon={day === today ? Inbox : ReceiptText}
              title={tm('money.history.none')}
              testId={`${testId}.empty`}
            />
          }
          label={tm('money.history.title')}
          testId={`${testId}.table`}
        />
      )}
    </div>
  );
}
