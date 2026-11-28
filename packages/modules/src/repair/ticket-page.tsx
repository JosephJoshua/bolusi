// The live servisan behind its page on the phone and the PC: the ticket, its sync statuses and the
// approvals asked on it, what the last action did, and running an action in place. The apps only
// draw it.
import { useMemo, useState } from 'react';

import type { ApprovalRow } from '../approvals/queries.js';
import { ta } from '../approvals/i18n.js';
import { useActionRunner, useDoneNote, type EntitySyncStatuses } from '../screen-kit/index.js';

import { useClearAskedNotice } from './asked-notice.js';
import { repairAbilities, type TicketAction } from './flows.js';
import type { UndoChangeInput } from './commands.js';
import { tn } from './i18n.js';
import type { TicketDetailRow } from './queries.js';
import { moneyRuntimeOf, readApprovals, useRepairQuery, useRepairRuntime } from './runtime.js';
import { TICKET_DONE_KEY } from './ticket-view.js';

export interface LoadedTicket {
  readonly ticket: TicketDetailRow | undefined;
  readonly statuses: EntitySyncStatuses;
  /** The approval requests on it (a discount or a cancel asked of an owner), newest first. */
  readonly approvals: readonly ApprovalRow[];
}

export function useTicketPage(ticketId: string, cacheKey: string) {
  const runtime = useRepairRuntime();
  const can = useMemo(() => repairAbilities(runtime.hasPermission), [runtime]);
  // Money back to the customer and a lowered bill are the ledger's steps, over repair's port.
  const money = useMemo(() => moneyRuntimeOf(runtime, () => null), [runtime]);
  const runner = useActionRunner();
  // What the last action did, already in words: repair's own steps and the parts steps say it in a
  // toast. Asking an owner is a lasting state instead: its note stays on the page while it waits.
  const { note, say } = useDoneNote();
  const [asked, setAsked] = useState(false);
  const done = asked ? ta('approvals.done.asked') : note;
  const setDone = (message: string | null): void => {
    const asking = message === ta('approvals.done.asked');
    setAsked(asking);
    say(asking ? null : message);
  };
  const [reloadNonce, setReloadNonce] = useState(0);
  const query = useRepairQuery<LoadedTicket>(
    async (rt) => {
      const page = await rt.query('getTicket', { ticketId });
      return {
        ticket: page.rows[0],
        statuses: await rt.ticketSyncStatuses([ticketId]),
        approvals: await readApprovals(rt, ticketId),
      };
    },
    `${cacheKey}:${ticketId}:${String(reloadNonce)}`,
  );
  useClearAskedNotice(
    done,
    () => setAsked(false),
    query.status === 'ready' ? query.data.approvals : undefined,
  );
  const ticket = query.status === 'ready' ? query.data.ticket : undefined;

  /**
   * Says what a status or technician change did, with Batalkan to take it back for a few seconds
   * (the server allows it only while nothing else changed on the servisan since).
   */
  const changed = (message: string, change: UndoChangeInput['change']): void => {
    setAsked(false);
    say(message, async () => {
      await runtime.run('undoChange', { ticketId, change });
    });
  };

  /** Runs an action that needs no step (starting again, claiming) and says what it did. */
  const runInPlace = (action: TicketAction, command: 'startWork' | 'claimTicket'): void => {
    setDone(null);
    void runner
      .run(() => runtime.run(command, { ticketId }))
      .then((result) => {
        const key = TICKET_DONE_KEY[action];
        if (result === undefined || key === undefined) return;
        changed(
          tn(key),
          command === 'claimTicket' ? 'repair.ticket_claimed' : 'repair.work_started',
        );
      });
  };

  return {
    runtime,
    can,
    money,
    runner,
    query,
    ticket,
    reload: () => setReloadNonce((n) => n + 1),
    done,
    setDone,
    changed,
    runInPlace,
  };
}
