/**
 * Kas — the store's money on a phone: what should be in the drawer, what came in today and by
 * which method, the drawer's moves, counts an owner still has to settle and what customers owe.
 * The board is one screen; each task on it (Tutup kas, cash out or in, settling a difference,
 * a customer paying a debt) is its own step, which the app's Kas surface opens and closes.
 */
import { formatDate, formatDateTime, formatMoney, formatTime } from '@bolusi/i18n';
import {
  AmountRow,
  AppShell,
  Banner,
  Button,
  color,
  Columns,
  LoadingState,
  numeric,
  radius,
  RollingText,
  space,
  Text,
  type,
} from '@bolusi/ui';
import { StyleSheet, View } from 'react-native';

import { Section, type ScreenChrome } from '../../screen-kit/screens/views.js';

import { tm } from '../i18n.js';
import { accountLabel, dayStart, differenceText, type NamedBalance } from '../kas.js';
import { useKasDay } from '../kas-day.js';
import type { CashCountRow } from '../queries.js';
import { useMoneyRuntime } from '../runtime.js';
import { useAskedAbout, useVoidRequests } from '../void-ask.js';
import { checksCount, usePaymentChecks } from '../payment-checks.js';
import { approvalKindKey, ta } from '../../approvals/i18n.js';

export interface KasBoardProps {
  readonly chrome: ScreenChrome;
  readonly now: () => number;
  readonly onCount: () => void;
  readonly onMove: () => void;
  readonly onSettle: (count: CashCountRow) => void;
  readonly onReceive: (balance: NamedBalance) => void;
  /** Give back what a customer paid beyond their bill. */
  readonly onRefund: (balance: NamedBalance) => void;
  /** The day's records; absent for someone who cannot read the store's money. */
  readonly onHistory?: (() => void) | undefined;
  /** Non-cash payments to tick off against the statement (owners). */
  readonly onChecks?: (() => void) | undefined;
  /** Said at the top once something was asked of an owner from here; pressing it clears it. */
  readonly notice?: string | null | undefined;
  readonly onClearNotice?: (() => void) | undefined;
  /** A tablet beside another pane shows no header of its own; absent on a phone. */
  readonly testID?: string | undefined;
}

export function KasBoard({
  chrome,
  now,
  onCount,
  onMove,
  onSettle,
  onReceive,
  onRefund,
  onHistory,
  onChecks,
  notice,
  onClearNotice,
  testID = 'money.kas',
}: KasBoardProps): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const {
    drawerQuery: drawer,
    drawer: drawerData,
    accounts: accountRows,
    entriesReady,
    moneyIn,
    moves,
    open,
    difference,
    counted,
    may,
  } = useKasDay(now);
  const { count: mayCount, settle: maySettle, receive: mayReceive, read: mayRead } = may;
  // What this person asked an owner for from Kas and was turned down today: told here, not only
  // in Riwayat.
  const since = dayStart(now());
  const turnedDown = useVoidRequests().turnedDown.filter((row) => (row.decidedAt ?? 0) >= since);
  const about = useAskedAbout(turnedDown);
  // Payments an owner still has to find on the statement: said only while some wait.
  const checks = usePaymentChecks(1, 0);
  const toCheck = checks.status === 'ready' ? checksCount(checks.data) : null;
  // Today's takings, what moved and what is owed sit beside the drawer. A blind count shows none
  // of the takings, and on a quiet day nothing else may be there: the drawer then keeps one
  // readable column instead of a wide half-empty page.
  const showsTakings = entriesReady && may.seeExpected;
  const hasSide =
    showsTakings || moves.length > 0 || open.owed.length > 0 || open.owedBack.length > 0;

  return (
    <AppShell
      scrollable
      title={tm('money.kas.title')}
      syncChip={chrome.syncChip}
      avatar={chrome.avatar}
      bottomAction={
        mayCount ? (
          <Button label={tm('money.kas.count')} onPress={onCount} testID={`${testID}.count`} />
        ) : undefined
      }
      banner={
        notice === null || notice === undefined ? undefined : (
          <Banner
            variant="info"
            message={notice}
            onPress={onClearNotice}
            testID={`${testID}.notice`}
          />
        )
      }
      wide={hasSide}
      testID={testID}
    >
      {/* On a tablet what is owed and what moved sit beside the drawer and today's takings. */}
      <Columns
        testID={`${testID}.columns`}
        start={
          <>
            {drawer.status === 'loading' ? (
              <LoadingState variant="spinner" />
            ) : drawerData === null ? null : (
              <View style={styles.drawer} testID={`${testID}.drawer`}>
                {may.seeExpected ? (
                  <>
                    <Text style={styles.label}>{tm('money.kas.expected')}</Text>
                    <RollingText
                      value={drawerData.expected}
                      style={styles.expected}
                      testID={`${testID}.expected`}
                    >
                      {formatMoney(drawerData.expected)}
                    </RollingText>
                  </>
                ) : (
                  <Text style={styles.label}>{tm('money.kas.drawer')}</Text>
                )}
                <Text style={styles.muted} testID={`${testID}.lastCount`}>
                  {counted === null
                    ? tm('money.kas.notCounted')
                    : tm('money.kas.counted', { time: formatTime(counted.countedAt) })}
                </Text>
                {/* A blind count hides what the drawer should hold; until it is counted, say why. */}
                {may.seeExpected || counted !== null ? null : (
                  <Text style={styles.muted} testID={`${testID}.blindHint`}>
                    {tm('money.kas.blindHint')}
                  </Text>
                )}
                {may.move || (onHistory !== undefined && mayRead) ? (
                  <View style={styles.drawerAction}>
                    {may.move ? (
                      <Button
                        label={tm('money.kas.move')}
                        variant="secondary"
                        size="compact"
                        onPress={onMove}
                        testID={`${testID}.move`}
                      />
                    ) : null}
                    {onHistory !== undefined && mayRead ? (
                      <Button
                        label={tm('money.history.open')}
                        variant="secondary"
                        size="compact"
                        onPress={onHistory}
                        testID={`${testID}.history`}
                      />
                    ) : null}
                  </View>
                ) : null}
              </View>
            )}

            {turnedDown.length === 0 ? null : (
              <Section title={tm('money.kas.turnedDown')} testID={`${testID}.turnedDown`}>
                {turnedDown.map((row) => (
                  <AmountRow
                    key={row.id}
                    label={ta(approvalKindKey(row.kind))}
                    detail={[about(row), [row.decidedByName, row.note].filter(Boolean).join(': ')]
                      .filter(Boolean)
                      .join(' · ')}
                    value={row.amount}
                    onPress={onHistory}
                    testID={`${testID}.turnedDown.${row.id}`}
                  />
                ))}
              </Section>
            )}

            {toCheck === null || toCheck.open === 0 || onChecks === undefined ? null : (
              <Section title={tm('money.checks.title')} testID={`${testID}.checks`}>
                <AmountRow
                  label={tm('money.checks.summary', {
                    count: `${String(toCheck.open)}${toCheck.more ? '+' : ''}`,
                  })}
                  detail={
                    toCheck.missing === 0
                      ? undefined
                      : tm('money.checks.missingCount', { count: String(toCheck.missing) })
                  }
                  value=""
                  onPress={onChecks}
                  testID={`${testID}.checks.open`}
                />
              </Section>
            )}

            {difference === null ? null : (
              <Section title={tm('money.kas.difference')} testID={`${testID}.differences`}>
                <AmountRow
                  label={formatDateTime(difference.countedAt)}
                  detail={
                    maySettle
                      ? (runtime.nameOf(difference.countedBy) ?? undefined)
                      : tm('money.kas.waitingOwner')
                  }
                  value={differenceText(difference.difference)}
                  tone={difference.difference < 0 ? 'danger' : 'text'}
                  onPress={maySettle ? () => onSettle(difference) : undefined}
                  testID={`${testID}.difference.${difference.id}`}
                />
              </Section>
            )}
          </>
        }
        end={
          !hasSide ? null : (
            <>
              {/* Today's takings add up to what should be in the drawer: not for a blind count. */}
              {showsTakings ? (
                <Section title={tm('money.kas.inToday')} testID={`${testID}.in`}>
                  {moneyIn.methods.length === 0 && moneyIn.refunded === 0 ? (
                    <Text style={styles.muted}>{tm('money.kas.nothingIn')}</Text>
                  ) : (
                    <>
                      {moneyIn.methods.map((method) => (
                        <AmountRow
                          key={method.account}
                          label={accountLabel(method.account, accountRows)}
                          value={method.amount}
                          testID={`${testID}.in.${method.account}`}
                        />
                      ))}
                      {moneyIn.refunded === 0 ? null : (
                        <AmountRow
                          label={tm('money.kas.refunded')}
                          value={-moneyIn.refunded}
                          testID={`${testID}.in.refunded`}
                        />
                      )}
                      <AmountRow
                        label={tm('money.kas.total')}
                        value={moneyIn.total}
                        strong
                        testID={`${testID}.in.total`}
                      />
                    </>
                  )}
                </Section>
              ) : null}
              {moves.length === 0 ? null : (
                <Section title={tm('money.kas.movesToday')} testID={`${testID}.moves`}>
                  {moves.map(({ entry, label, delta }) => (
                    <AmountRow
                      key={entry.id}
                      label={tm(label)}
                      detail={[formatTime(entry.createdAt), entry.reason]
                        .filter(Boolean)
                        .join(' · ')}
                      value={delta}
                      signed
                      testID={`${testID}.moves.${entry.id}`}
                    />
                  ))}
                </Section>
              )}

              {open.owed.length === 0 ? null : (
                <Section title={tm('money.kas.owed')} testID={`${testID}.owed`}>
                  {open.owed.map((row) => (
                    <AmountRow
                      key={row.documentId}
                      label={row.customer ?? row.documentLabel}
                      detail={[
                        row.customer === null ? null : row.documentLabel,
                        tm('money.kas.since', { date: formatDate(row.since) }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      value={row.balance}
                      onPress={mayReceive ? () => onReceive(row) : undefined}
                      testID={`${testID}.owed.${row.documentId}`}
                    />
                  ))}
                </Section>
              )}

              {open.owedBack.length === 0 ? null : (
                <Section title={tm('money.kas.owedBack')} testID={`${testID}.owedBack`}>
                  <Text style={styles.muted}>{tm('money.kas.owedBackHint')}</Text>
                  {open.owedBack.map((row) => (
                    <AmountRow
                      key={row.documentId}
                      label={row.customer ?? row.documentLabel}
                      detail={row.customer === null ? undefined : row.documentLabel}
                      value={-row.balance}
                      onPress={mayReceive ? () => onRefund(row) : undefined}
                      testID={`${testID}.owedBack.${row.documentId}`}
                    />
                  ))}
                </Section>
              )}
            </>
          )
        }
      />
    </AppShell>
  );
}

const styles = StyleSheet.create({
  drawer: {
    padding: space.lg,
    borderRadius: radius.md,
    backgroundColor: color.surfaceAlt,
  },
  label: { ...type.bodySm, color: color.textMuted },
  expected: {
    ...type.title,
    color: color.text,
    ...numeric,
    marginTop: space.xs,
  },
  muted: { ...type.bodySm, color: color.textMuted, marginTop: space.xs },
  drawerAction: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
});
