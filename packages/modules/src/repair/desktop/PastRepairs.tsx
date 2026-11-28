// The customer's other servisan on the PC's servisan pane, as the phone lists them: a warranty
// return or a regular is plain at a glance, and each row opens that servisan.
import { formatMoney } from '@bolusi/i18n';
import { Button, Section } from '@bolusi/ui-web';
import { useState } from 'react';

import { PAST_REPAIRS_SHOWN, pastRepairLine } from '../customer-repairs.js';
import { tn } from '../i18n.js';
import { useCustomerRepairs } from '../runtime.js';

export function PastRepairs({
  customerId,
  ticketId,
  onOpenTicket,
  testId,
}: {
  readonly customerId: string;
  readonly ticketId: string;
  readonly onOpenTicket?: ((ticketId: string) => void) | undefined;
  readonly testId: string;
}): React.JSX.Element | null {
  const repairs = useCustomerRepairs(customerId, ticketId);
  const [all, setAll] = useState(false);
  // Reference, not a task: nothing shows until there is something to show.
  if (repairs.status !== 'ready' || repairs.data.length === 0) return null;
  const rows = all ? repairs.data : repairs.data.slice(0, PAST_REPAIRS_SHOWN);
  return (
    <Section title={tn('repair.pastRepairs.title')} testId={testId}>
      <ul className="divide-y divide-border">
        {rows.map((row) => {
          const line = pastRepairLine(row);
          const body = (
            <>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="break-words text-body text-text">{line.device}</span>
                <span className="break-words text-small text-text-muted">{line.detail}</span>
              </span>
              <span className="tabular whitespace-nowrap text-body font-semibold text-text">
                {formatMoney(line.amount)}
              </span>
            </>
          );
          return (
            <li key={line.id} data-testid={`${testId}.row.${line.id}`}>
              {onOpenTicket === undefined ? (
                <div className="flex items-start gap-4 py-2">{body}</div>
              ) : (
                <button
                  type="button"
                  onClick={() => onOpenTicket(line.id)}
                  className="-mx-2 flex w-[calc(100%+1rem)] cursor-pointer items-start gap-4 rounded-sm px-2 py-2 text-left hover:bg-surface-alt focus-visible:bg-surface-alt focus-visible:outline-none"
                  data-testid={`${testId}.open.${line.id}`}
                >
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {rows.length === repairs.data.length ? null : (
        <Button
          label={tn('repair.pastRepairs.showAll', { count: repairs.data.length })}
          variant="text"
          size="sm"
          className="-ml-2 self-start"
          onClick={() => setAll(true)}
          data-testid={`${testId}.showAll`}
        />
      )}
    </Section>
  );
}
