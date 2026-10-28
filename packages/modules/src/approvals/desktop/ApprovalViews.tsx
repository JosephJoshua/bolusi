// The PC's approval pieces: the requests on a record (a servisan's pane), and the dialog that
// answers one (approve or reject, with a note) or takes it back. What a request is about reads in
// its own module's words, handed in as an `ApprovalDescription`.
import { formatDateTime, t } from '@bolusi/i18n';
import { Button, Chip, ConfirmDialog, Dialog, Section, TextField } from '@bolusi/ui-web';
import { CircleCheck, CircleX, Clock, Undo2, type LucideIcon } from 'lucide-react';
import { useState } from 'react';

import { useActionRunner } from '../../screen-kit/index.js';
import { ActionError } from '../../screen-kit/desktop/index.js';
import {
  APPROVAL_STATUS_TONE,
  approvalActionable,
  approvalByLine,
  approvalStatusLabel,
  type ApprovalDescription,
} from '../copy.js';
import { approvalKindKey, ta, type ApprovalsKey } from '../i18n.js';
import type { ApprovalRow } from '../queries.js';
import type { ApprovalsPort } from '../runtime.js';

const STATUS_ICON: Readonly<Record<ApprovalRow['status'], LucideIcon>> = {
  waiting: Clock,
  approved: CircleCheck,
  rejected: CircleX,
  withdrawn: Undo2,
  closed: Undo2,
};

export function ApprovalStatusChip({
  status,
}: {
  readonly status: ApprovalRow['status'];
}): React.JSX.Element {
  return (
    <Chip
      label={approvalStatusLabel(status)}
      icon={STATUS_ICON[status]}
      tone={APPROVAL_STATUS_TONE[status]}
    />
  );
}

/** A record's requests, newest first, as one section; nothing when it has none. */
export function ApprovalSection({
  rows,
  describe,
  onOpen,
  testId,
}: {
  readonly rows: readonly ApprovalRow[];
  readonly describe: (row: ApprovalRow) => ApprovalDescription;
  readonly onOpen: (row: ApprovalRow) => void;
  readonly testId: string;
}): React.JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <Section title={ta('approvals.section.title')} testId={testId}>
      <ul className="flex flex-col">
        {rows.map((row) => {
          const description = describe(row);
          const heading = [ta(approvalKindKey(row.kind)), description.amount]
            .filter((part) => part !== null)
            .join(' · ');
          return (
            <li
              key={row.id}
              className="flex items-center gap-4 border-b border-border py-2 last:border-b-0"
              data-testid={`${testId}.${row.id}`}
            >
              <div className="min-w-0 flex-1">
                <p className="tabular text-body font-semibold text-text">{heading}</p>
                <p className="break-words text-small text-text-muted">{approvalByLine(row)}</p>
              </div>
              <ApprovalStatusChip status={row.status} />
              {approvalActionable(row) ? (
                <Button
                  label={ta(row.canDecide ? 'approvals.action.decide' : 'approvals.action.open')}
                  size="sm"
                  onClick={() => onOpen(row)}
                  data-testid={`${testId}.${row.id}.open`}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/**
 * One request in a dialog. The approver answers it ("Setujui" records the decision itself, as
 * theirs); the asker can take it back while it waits.
 */
export function ApprovalDialog({
  port,
  request,
  description,
  onDone,
  onClose,
  testId = 'approvals.desk.dialog',
}: {
  readonly port: ApprovalsPort;
  readonly request: ApprovalRow;
  readonly description: ApprovalDescription;
  /** Closes the dialog, with what happened in words. */
  readonly onDone: (notice: string) => void;
  readonly onClose: () => void;
  readonly testId?: string | undefined;
}): React.JSX.Element {
  const runner = useActionRunner();
  const [note, setNote] = useState('');
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const decides = request.canDecide && request.status === 'waiting';
  const withdraws = request.mine && request.status === 'waiting';

  const act = (
    command: 'approveRequest' | 'rejectRequest' | 'withdrawRequest',
    notice: ApprovalsKey,
  ): void => {
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

  return (
    <>
      <Dialog
        open
        onRequestClose={onClose}
        title={ta('approvals.step.title')}
        closeLabel={t('core.action.close')}
        banner={
          runner.errorCode === null ? undefined : (
            <ActionError errorCode={runner.errorCode} onDismiss={runner.clearError} />
          )
        }
        size="sm"
        testId={testId}
        footer={
          decides ? (
            <>
              <p id={`${testId}.question`} className="mr-auto text-body font-semibold text-text">
                {ta('approvals.step.question')}
              </p>
              <Button
                label={ta('approvals.action.reject')}
                onClick={() => act('rejectRequest', 'approvals.done.rejected')}
                aria-describedby={`${testId}.question`}
                disabled={runner.busy}
                data-testid={`${testId}.reject`}
              />
              <Button
                label={ta('approvals.action.approve')}
                variant="primary"
                onClick={() => act('approveRequest', 'approvals.done.approved')}
                aria-describedby={`${testId}.question`}
                busy={runner.busy}
                data-testid={`${testId}.approve`}
              />
            </>
          ) : (
            <>
              {withdraws ? (
                <Button
                  label={ta('approvals.action.withdraw')}
                  variant="dangerText"
                  className="-ml-2 mr-auto"
                  onClick={() => setConfirmWithdraw(true)}
                  disabled={runner.busy}
                  data-testid={`${testId}.withdraw`}
                />
              ) : null}
              <Button label={t('core.action.close')} onClick={onClose} />
            </>
          )
        }
      >
        <div className="rounded-sm bg-surface-alt p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-small text-text-muted">{ta(approvalKindKey(request.kind))}</p>
            <ApprovalStatusChip status={request.status} />
          </div>
          <p className="mt-1 break-words text-body font-semibold text-text">{description.title}</p>
          {description.amount === null ? null : (
            <p className="tabular text-title font-bold text-text" data-testid={`${testId}.amount`}>
              {description.amount}
            </p>
          )}
          <p className="mt-4 text-small text-text-muted">
            {ta('approvals.step.askedBy', {
              name: request.requestedByName ?? '–',
              time: formatDateTime(request.requestedAt),
            })}
          </p>
          <p className="break-words text-body text-text" data-testid={`${testId}.reason`}>
            {request.reason}
          </p>
        </div>
        {description.notes.map((line) => (
          <p key={line} className="mt-4 text-small text-text-muted">
            {line}
          </p>
        ))}
        {decides ? (
          <TextField
            className="mt-4"
            label={ta('approvals.step.note')}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            data-testid={`${testId}.note`}
          />
        ) : null}
      </Dialog>
      <ConfirmDialog
        open={confirmWithdraw}
        title={ta('approvals.withdraw.title')}
        message={ta('approvals.withdraw.message')}
        confirmLabel={ta('approvals.action.withdraw')}
        cancelLabel={t('core.action.cancel')}
        closeLabel={t('core.action.close')}
        destructive
        onConfirm={() => {
          setConfirmWithdraw(false);
          act('withdrawRequest', 'approvals.done.withdrawn');
        }}
        onCancel={() => setConfirmWithdraw(false)}
        testId={`${testId}.withdrawConfirm`}
      />
    </>
  );
}
