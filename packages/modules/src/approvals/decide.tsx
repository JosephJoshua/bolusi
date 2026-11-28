// Deciding or withdrawing an approval request, the same on the phone and the PC. A decider beyond
// their own limit cannot approve (`beyond`); the asker can take a waiting request back. Each app
// only draws the request.
import { useState } from 'react';

import { useActionRunner } from '../screen-kit/index.js';

import { approvalBeyondLimit } from './copy.js';
import { ta, type ApprovalsKey } from './i18n.js';
import type { ApprovalRow } from './queries.js';
import type { ApprovalsPort } from './runtime.js';

export type ApprovalAction = 'approveRequest' | 'rejectRequest' | 'withdrawRequest';

/** `onDone` gets what happened, in words. */
export function useApprovalDecision(
  port: ApprovalsPort,
  request: ApprovalRow,
  onDone: (notice: string) => void,
) {
  const runner = useActionRunner();
  const [note, setNote] = useState('');
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const decides = request.canDecide && request.status === 'waiting';
  const act = (command: ApprovalAction, notice: ApprovalsKey): void => {
    void runner
      .run(() =>
        command === 'withdrawRequest'
          ? port.run(command, { requestId: request.id })
          : port.run(command, { requestId: request.id, note: note.trim() === '' ? null : note }),
      )
      .then((result) => {
        if (result !== undefined) onDone(ta(notice));
      });
  };
  return {
    runner,
    note,
    setNote,
    confirmWithdraw,
    setConfirmWithdraw,
    decides,
    /** Why this decider cannot approve it, beyond their own limit; null when they can. */
    beyond: decides ? approvalBeyondLimit(request, port.limitOf) : null,
    /** The asker can take it back while it waits. */
    withdraws: request.mine && request.status === 'waiting',
    act,
  };
}
