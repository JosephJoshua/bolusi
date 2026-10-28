// The phone's approval pieces: the requests on a record (a servisan's page), and the full-screen
// step that answers one (approve or reject, with a note) or takes it back. What a request is
// about reads in its own module's words, handed in as a `ApprovalDescription`.
import { formatDateTime } from '@bolusi/i18n';
import {
  Chip,
  ConfirmSheet,
  ListRow,
  TextButton,
  TextInput,
  color,
  radius,
  space,
  type,
  type IconName,
} from '@bolusi/ui';
import { t } from '@bolusi/i18n';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useActionRunner } from '../../screen-kit/index.js';
import { FlowScreen, Section, type ScreenChrome } from '../../screen-kit/screens/views.js';
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

const STATUS_ICON: Readonly<Record<ApprovalRow['status'], IconName>> = {
  waiting: 'pending',
  approved: 'success',
  rejected: 'rejected',
  withdrawn: 'remove',
  closed: 'remove',
};

export function ApprovalStatusChip({
  status,
  testID,
}: {
  readonly status: ApprovalRow['status'];
  readonly testID: string;
}): React.JSX.Element {
  return (
    <Chip
      label={approvalStatusLabel(status)}
      icon={STATUS_ICON[status]}
      tone={APPROVAL_STATUS_TONE[status]}
      testID={testID}
    />
  );
}

/**
 * A record's requests, newest first, as one section; nothing when it has none. A row opens when
 * there is something to do with it: answer it, or take it back.
 */
export function ApprovalSection({
  rows,
  describe,
  onOpen,
  testID,
}: {
  readonly rows: readonly ApprovalRow[];
  readonly describe: (row: ApprovalRow) => ApprovalDescription;
  readonly onOpen: (row: ApprovalRow) => void;
  readonly testID: string;
}): React.JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <Section title={ta('approvals.section.title')} testID={testID}>
      {/* A row's own padding is hit area: its text lines up with the screen's content edge. */}
      <View style={styles.rows}>
        {rows.map((row) => {
          const description = describe(row);
          return (
            <ListRow
              key={row.id}
              primaryText={[ta(approvalKindKey(row.kind)), description.amount]
                .filter((part) => part !== null)
                .join(' · ')}
              secondaryText={approvalByLine(row)}
              trailing={
                <ApprovalStatusChip status={row.status} testID={`${testID}.${row.id}.status`} />
              }
              onPress={approvalActionable(row) ? () => onOpen(row) : undefined}
              testID={`${testID}.${row.id}`}
            />
          );
        })}
      </View>
    </Section>
  );
}

/**
 * One request, full screen. The approver answers it ("Setujui" records the decision itself, as
 * theirs); the asker can take it back while it waits.
 */
export function ApprovalStep({
  chrome,
  port,
  request,
  description,
  onDone,
  onCancel,
  testID = 'approvals.step',
}: {
  readonly chrome: ScreenChrome;
  readonly port: ApprovalsPort;
  readonly request: ApprovalRow;
  readonly description: ApprovalDescription;
  /** Closes the step, with what happened in words. */
  readonly onDone: (notice: string) => void;
  readonly onCancel: () => void;
  readonly testID?: string | undefined;
}): React.JSX.Element {
  const runner = useActionRunner();
  const [note, setNote] = useState('');
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const decides = request.canDecide && request.status === 'waiting';

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
    <FlowScreen
      chrome={chrome}
      title={ta('approvals.step.title')}
      onBack={onCancel}
      question={decides ? ta('approvals.step.question') : undefined}
      primaryLabel={decides ? ta('approvals.action.approve') : undefined}
      onPrimary={decides ? () => act('approveRequest', 'approvals.done.approved') : undefined}
      secondary={
        decides
          ? {
              label: ta('approvals.action.reject'),
              onPress: () => act('rejectRequest', 'approvals.done.rejected'),
              testID: `${testID}.reject`,
            }
          : undefined
      }
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      overlay={
        confirmWithdraw ? (
          <ConfirmSheet
            title={ta('approvals.withdraw.title')}
            message={ta('approvals.withdraw.message')}
            confirmLabel={ta('approvals.action.withdraw')}
            onConfirm={() => {
              setConfirmWithdraw(false);
              act('withdrawRequest', 'approvals.done.withdrawn');
            }}
            cancelLabel={t('core.action.cancel')}
            onCancel={() => setConfirmWithdraw(false)}
            testID={`${testID}.withdrawConfirm`}
          />
        ) : undefined
      }
      testID={testID}
    >
      <View style={styles.box}>
        <View style={styles.header}>
          <Text style={styles.kind}>{ta(approvalKindKey(request.kind))}</Text>
          <ApprovalStatusChip status={request.status} testID={`${testID}.status`} />
        </View>
        <Text style={styles.title}>{description.title}</Text>
        {description.amount === null ? null : (
          <Text style={styles.amount} testID={`${testID}.amount`}>
            {description.amount}
          </Text>
        )}
        <Text style={styles.label}>
          {ta('approvals.step.askedBy', {
            name: request.requestedByName ?? '–',
            time: formatDateTime(request.requestedAt),
          })}
        </Text>
        <Text style={styles.reason} testID={`${testID}.reason`}>
          {request.reason}
        </Text>
      </View>
      {description.notes.map((line) => (
        <Text key={line} style={styles.note}>
          {line}
        </Text>
      ))}
      {decides ? (
        <View style={styles.gap}>
          <TextInput
            label={ta('approvals.step.note')}
            value={note}
            onChangeText={setNote}
            testID={`${testID}.note`}
          />
        </View>
      ) : null}
      {request.mine && request.status === 'waiting' ? (
        <View style={styles.withdraw}>
          <TextButton
            label={ta('approvals.action.withdraw')}
            tone="danger"
            onPress={() => setConfirmWithdraw(true)}
            disabled={runner.busy}
            testID={`${testID}.withdraw`}
          />
        </View>
      ) : null}
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  rows: { marginHorizontal: -space.lg },
  box: { padding: space.md, borderRadius: radius.sm, backgroundColor: color.surfaceAlt },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  kind: { ...type.caption, color: color.textMuted, flexShrink: 1 },
  title: { ...type.bodyBold, color: color.text, marginTop: space.xs },
  amount: { ...type.title, color: color.text, marginTop: space.xs, fontVariant: ['tabular-nums'] },
  label: { ...type.caption, color: color.textMuted, marginTop: space.md },
  reason: { ...type.bodySm, color: color.text },
  note: { ...type.bodySm, color: color.textMuted, marginTop: space.md },
  gap: { marginTop: space.xl },
  withdraw: { marginTop: space.xl, alignItems: 'flex-start', marginLeft: -space.sm },
});
