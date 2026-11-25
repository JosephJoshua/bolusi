/**
 * Cocokkan mutasi on the counter PC: the phone's list (money/screens/PaymentChecks.tsx) as a table
 * an owner works down beside the bank statement, oldest first, answering each payment in its row.
 */
import { formatDate, formatMoney, formatTime } from '@bolusi/i18n';
import { Button, DataTable, OverflowText, StatePanel, type ColumnDef } from '@bolusi/ui-web';
import { BadgeCheck } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useActionRunner } from '../../screen-kit/index.js';
import { ActionError, QueryPanel } from '../../screen-kit/desktop/index.js';

import type { PaymentCheckOutcome } from '../constants.js';
import { tm } from '../i18n.js';
import { CHECK_ANSWER_KEY, checkLine, usePaymentChecks } from '../payment-checks.js';
import type { MoneyEntryRow } from '../queries.js';
import { useMoneyRuntime } from '../runtime.js';

export function PaymentChecks(): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const [pages, setPages] = useState(1);
  const [nonce, setNonce] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const checks = usePaymentChecks(pages, nonce);
  const loaded = checks.status === 'ready' ? checks.data : null;
  const testId = 'money.desk.checks';

  const columns = useMemo((): ColumnDef<MoneyEntryRow, unknown>[] => {
    const answer = (entry: MoneyEntryRow, outcome: PaymentCheckOutcome): void => {
      if (answering !== null) return;
      setAnswering(entry.id);
      void runner
        .run(() => runtime.run('checkPayment', { entryId: entry.id, outcome }))
        .finally(() => setAnswering(null));
    };
    const lineOf = (entry: MoneyEntryRow) =>
      checkLine(
        entry,
        loaded?.accounts ?? [],
        entry.documentId === null ? null : (loaded?.customers.get(entry.documentId) ?? null),
      );
    return [
      {
        id: 'date',
        accessorFn: (row) => row.createdAt,
        header: tm('money.history.col.time'),
        meta: { track: '112px' },
        cell: ({ row: { original: entry } }) => (
          <span className="tabular block text-body text-text-muted">
            {formatDate(entry.createdAt)}
            <span className="block text-small">{formatTime(entry.createdAt)}</span>
          </span>
        ),
      },
      {
        id: 'payment',
        header: tm('money.checks.col.payment'),
        meta: { track: 'minmax(240px, 1fr)' },
        cell: ({ row: { original: entry } }) => {
          const line = lineOf(entry);
          // The time has its own column here; the rest of the line reads as on the phone.
          const details = line.details.slice(1);
          return (
            <span className="block min-w-0">
              <span className="text-body text-text">{line.method}</span>
              {details.length === 0 ? null : (
                <OverflowText text={details.join(' · ')} className="text-small text-text-muted" />
              )}
              {line.missing === null ? null : (
                <span
                  className="block text-small text-danger"
                  data-testid={`${testId}.missing.${entry.id}`}
                >
                  {line.missing}
                </span>
              )}
            </span>
          );
        },
      },
      {
        id: 'amount',
        header: tm('money.pay.amount'),
        meta: { track: '136px', align: 'end' },
        cell: ({ row: { original: entry } }) => (
          <span className="tabular text-body font-semibold text-text">
            {formatMoney(entry.amount)}
          </span>
        ),
      },
      {
        id: 'answers',
        header: '',
        // Both answers on one line: "Tidak ada di mutasi" and "Cocok".
        meta: { track: '272px', align: 'end' },
        cell: ({ row: { original: entry } }) => {
          const line = lineOf(entry);
          return (
            <span className="flex justify-end gap-2">
              {line.answers.map((outcome) => (
                <Button
                  key={outcome}
                  label={tm(CHECK_ANSWER_KEY[outcome])}
                  aria-label={tm('money.checks.answerLabel', {
                    answer: tm(CHECK_ANSWER_KEY[outcome]),
                    method: line.method,
                    amount: formatMoney(entry.amount),
                    time: `${formatDate(entry.createdAt)} ${formatTime(entry.createdAt)}`,
                  })}
                  size="sm"
                  busy={answering === entry.id}
                  disabled={answering !== null && answering !== entry.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    answer(entry, outcome);
                  }}
                  data-testid={`${testId}.${outcome}.${entry.id}`}
                />
              ))}
            </span>
          );
        },
      },
    ];
  }, [loaded, answering, runner, runtime]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid={testId}>
      <div className="flex min-h-14 flex-wrap items-center gap-2 px-6 py-2">
        <p className="text-body text-text-muted">{tm('money.checks.hint')}</p>
      </div>
      {runner.errorCode === null ? null : (
        <div className="px-6 pb-3">
          <ActionError errorCode={runner.errorCode} onDismiss={runner.clearError} />
        </div>
      )}
      {checks.status === 'unauthorized' || checks.status === 'error' ? (
        <QueryPanel query={checks} onRetry={() => setNonce((n) => n + 1)}>
          {() => null}
        </QueryPanel>
      ) : (
        <DataTable
          rows={loaded?.rows ?? []}
          columns={columns}
          getRowId={(row) => row.id}
          selectedId={selected}
          onSelect={(row) => setSelected(row.id)}
          // Oldest first, as a statement reads.
          sortable={false}
          scrollKey="checks"
          onEndReached={loaded?.more === true ? () => setPages((n) => n + 1) : undefined}
          loading={checks.status === 'loading'}
          empty={
            <StatePanel
              icon={BadgeCheck}
              title={tm('money.checks.none')}
              testId={`${testId}.empty`}
            />
          }
          label={tm('money.checks.title')}
          testId={`${testId}.table`}
        />
      )}
    </div>
  );
}
