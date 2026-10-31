/**
 * Riwayat: the store's money records one day at a time, newest first, so an owner can see what
 * happened and cancel a payment recorded by mistake. Cancelling keeps the record, struck through
 * with its reason; the books reverse it (money/applier.ts).
 */
import { formatDate, formatDateTime, formatMoney, formatTime } from '@bolusi/i18n';
import { Button, EmptyState, TextButton, TextInput, color, space, type, Text } from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useActionRunner, type DiscardGuard } from '../../screen-kit/index.js';
import { useDiscardConfirm } from '../../screen-kit/screens/discard.js';
import { FlowScreen, QueryView, type ScreenChrome } from '../../screen-kit/screens/views.js';

import { MAX_REASON } from '../constants.js';
import { APPROVAL_PERMISSION } from '../../approvals/constants.js';
import { tm } from '../i18n.js';
import { shiftDay, useDayRecords } from '../day-records.js';
import { accountLabel, dayStart, historyLine, voidAbilities, voidable, voidKind } from '../kas.js';
import type { MoneyEntryRow } from '../queries.js';
import { useMoneyQuery, useMoneyRuntime } from '../runtime.js';
import { useVoidAsk, useWaitingVoids, voidRequest } from '../void-ask.js';
import { ta } from '../../approvals/i18n.js';

import { Row } from './Kas.js';

export interface KasHistoryProps {
  readonly chrome: ScreenChrome;
  readonly now: () => number;
  /** The day shown, kept by the surface so it is still there back from a record; null for today. */
  readonly day: number | null;
  readonly onDay: (day: number) => void;
  readonly onBack: () => void;
  /** An owner opens a payment to cancel it (the counter, to ask an owner to). */
  readonly onVoid: (entry: MoneyEntryRow) => void;
  /** Said back from a record, e.g. that an owner was asked. */
  readonly notice?: string | null | undefined;
  readonly onClearNotice?: (() => void) | undefined;
  readonly testID?: string | undefined;
}

export function KasHistory({
  chrome,
  now,
  day: chosen,
  onDay,
  onBack,
  onVoid,
  notice,
  onClearNotice,
  testID = 'money.history',
}: KasHistoryProps): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const can = voidAbilities(
    (id) => runtime.hasPermission(id),
    (id) => runtime.limitOf(id),
    runtime.approvals.hasPermission(APPROVAL_PERMISSION.use),
  );
  const [pages, setPages] = useState(1);
  const [nonce, setNonce] = useState(0);
  const today = dayStart(now());
  const day = chosen ?? today;
  const records = useDayRecords(day, pages, nonce);
  const waiting = useWaitingVoids();

  const goTo = (next: number): void => {
    setPages(1);
    onDay(next);
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tm('money.history.title')}
      onBack={onBack}
      notice={notice}
      onClearNotice={onClearNotice}
      busy={false}
      errorCode={null}
      onClearError={() => undefined}
      testID={testID}
    >
      <View style={styles.days}>
        <TextButton
          label={tm('money.history.previousDay')}
          onPress={() => goTo(shiftDay(day, -1))}
          testID={`${testID}.previous`}
        />
        <Text style={styles.day} testID={`${testID}.day`}>
          {day === today ? tm('money.history.today') : formatDate(day)}
        </Text>
        <TextButton
          label={tm('money.history.nextDay')}
          onPress={() => goTo(shiftDay(day, 1))}
          disabled={day >= today}
          testID={`${testID}.next`}
        />
      </View>
      <QueryView
        query={records}
        onBack={onBack}
        onRetry={() => setNonce((n) => n + 1)}
        testID={testID}
      >
        {({ rows, more, customers, accounts }) =>
          rows.length === 0 ? (
            <EmptyState title={tm('money.history.none')} testID={`${testID}.empty`} />
          ) : (
            <View>
              {rows.map((entry) => {
                const line = historyLine(
                  entry,
                  accounts,
                  entry.documentId === null ? null : (customers.get(entry.documentId) ?? null),
                );
                const asked = waiting.has(entry.id) && entry.voidedAt === null;
                return (
                  <Row
                    key={entry.id}
                    label={tm(line.label)}
                    detail={[
                      formatTime(entry.createdAt),
                      ...line.details,
                      ...(asked ? [tm('money.void.waiting')] : []),
                    ].join(' · ')}
                    value={line.amount}
                    tone={line.voided ? 'struck' : 'text'}
                    onPress={!asked && voidable(entry, can) ? () => onVoid(entry) : undefined}
                    testID={`${testID}.entry.${entry.id}`}
                  />
                );
              })}
              {more ? (
                <View style={styles.more}>
                  <Button
                    label={tm('money.history.more')}
                    variant="secondary"
                    onPress={() => setPages((n) => n + 1)}
                    testID={`${testID}.more`}
                  />
                </View>
              ) : null}
            </View>
          )
        }
      </QueryView>
    </FlowScreen>
  );
}

// ── an owner cancels a payment (the counter asks one to) ───────────────────────────────────────

export interface VoidPaymentStepProps {
  readonly chrome: ScreenChrome;
  readonly entry: MoneyEntryRow;
  readonly onDone: () => void;
  /** An owner was asked to cancel it instead. */
  readonly onAsked: () => void;
  readonly onCancel: () => void;
  readonly onRegisterDiscardGuard?: ((guard: DiscardGuard | null) => void) | undefined;
  readonly testID?: string | undefined;
}

/**
 * A payment recorded by mistake (wrong method, typed twice) is cancelled with a reason. The
 * customer's balance goes back up, so a real payment is then taken again through the right method.
 */
export function VoidPaymentStep({
  chrome,
  entry,
  onDone,
  onAsked,
  onCancel,
  onRegisterDiscardGuard,
  testID = 'money.void',
}: VoidPaymentStepProps): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const runner = useActionRunner();
  const accounts = useMoneyQuery(
    async (rt) => (await rt.query('paymentAccounts', { includeInactive: true })).rows,
    'accounts',
  );
  const [reason, setReason] = useState('');
  const kind = voidKind(entry);
  // A limited role (a manager) sees its limit up front; beyond it, or without the decision, an
  // owner is asked instead.
  const ask = useVoidAsk(entry);
  const blocked = ask.asking && !ask.mayAsk;
  const discard = useDiscardConfirm({
    dirty: reason.trim() !== '',
    copy: {
      title: tm('money.discard.title'),
      message: tm('money.discard.message'),
      confirm: tm('money.discard.confirm'),
      keep: tm('money.discard.keep'),
    },
    onRegisterDiscardGuard,
    testID,
  });
  const method = accountLabel(
    entry.account ?? '',
    accounts.status === 'ready' ? accounts.data : [],
  );

  const submit = (): void => {
    if (reason.trim() === '' || blocked || ask.pending) return;
    void runner
      .run<unknown>(() =>
        ask.asking
          ? runtime.approvals.run('requestApproval', voidRequest(entry, reason))
          : runtime.run(kind.command, { entryId: entry.id, reason }),
      )
      .then((result) => {
        if (result !== undefined) (ask.asking ? onAsked : onDone)();
      });
  };

  return (
    <FlowScreen
      chrome={chrome}
      title={tm(kind.title)}
      onBack={() => discard.requestLeave(onCancel)}
      overlay={discard.overlay}
      primaryLabel={ask.asking ? ta('approvals.action.ask') : tm(kind.save)}
      primaryVariant={ask.asking ? 'primary' : 'destructive'}
      onPrimary={submit}
      primaryDisabled={reason.trim() === '' || blocked || ask.pending}
      primaryHint={tm(blocked ? 'money.refusal.overLimit' : 'money.void.hint')}
      busy={runner.busy}
      errorCode={runner.errorCode}
      onClearError={runner.clearError}
      testID={testID}
    >
      <Text style={styles.amount} testID={`${testID}.amount`}>
        {formatMoney(entry.amount)}
      </Text>
      <Text style={styles.muted}>
        {[method, entry.documentLabel, formatDateTime(entry.createdAt)]
          .filter((part) => part !== null && part !== '')
          .join(' · ')}
      </Text>
      <Text style={styles.body}>{tm(kind.explain)}</Text>
      {ask.limit === null ? null : (
        <Text style={styles.muted} testID={`${testID}.limit`}>
          {tm('money.void.limit', { amount: formatMoney(ask.limit) })}
        </Text>
      )}
      {ask.withEarlier === null ? null : (
        <Text style={styles.muted} testID={`${testID}.withEarlier`}>
          {tm('money.void.withEarlier', { amount: formatMoney(ask.withEarlier) })}
        </Text>
      )}
      {ask.asking && ask.mayAsk ? (
        <Text style={styles.muted} testID={`${testID}.asks`}>
          {tm(ask.because)}
        </Text>
      ) : null}
      <View style={styles.gap}>
        <TextInput
          label={tm('money.void.reason')}
          value={reason}
          onChangeText={setReason}
          maxLength={MAX_REASON}
          testID={`${testID}.reason`}
        />
      </View>
    </FlowScreen>
  );
}

const styles = StyleSheet.create({
  days: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.sm,
  },
  day: { ...type.bodyBold, color: color.text, flex: 1, textAlign: 'center' },
  more: { marginTop: space.lg },
  amount: { ...type.title, color: color.text, fontVariant: ['tabular-nums'] },
  muted: { ...type.bodySm, color: color.textMuted, marginTop: space.xs },
  body: { ...type.body, color: color.text, marginTop: space.lg },
  gap: { marginTop: space.lg },
});
