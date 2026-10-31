/**
 * Kas — the store's money on a phone: what should be in the drawer, what came in today and by
 * which method, the drawer's moves, counts an owner still has to settle and what customers owe.
 * The board is one screen; each task on it (Tutup kas, cash out or in, settling a difference,
 * a customer paying a debt) is its own step, which the app's Kas surface opens and closes.
 */
import { formatDate, formatDateTime, formatMoney, formatTime } from '@bolusi/i18n';
import {
  AppShell,
  Button,
  Icon,
  LoadingState,
  RollingText,
  border,
  color,
  radius,
  space,
  touch,
  type,
  Text,
} from '@bolusi/ui';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Section, type ScreenChrome } from '../../screen-kit/screens/views.js';

import { tm } from '../i18n.js';
import { accountLabel, differenceText, type NamedBalance } from '../kas.js';
import { useKasDay } from '../kas-day.js';
import type { CashCountRow } from '../queries.js';
import { useMoneyRuntime } from '../runtime.js';

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
  testID = 'money.kas',
}: KasBoardProps): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const {
    drawerQuery: drawer,
    drawer: drawerData,
    accounts: accountRows,
    entriesReady,
    methods,
    moves,
    open,
    difference,
    counted,
    may,
  } = useKasDay(now);
  const { count: mayCount, settle: maySettle, receive: mayReceive, read: mayRead } = may;

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
      testID={testID}
    >
      {drawer.status === 'loading' ? (
        <LoadingState variant="spinner" />
      ) : drawerData === null ? null : (
        <View style={styles.drawer} testID={`${testID}.drawer`}>
          <Text style={styles.label}>{tm('money.kas.expected')}</Text>
          <RollingText
            value={drawerData.expected}
            style={styles.expected}
            testID={`${testID}.expected`}
          >
            {formatMoney(drawerData.expected)}
          </RollingText>
          <Text style={styles.muted} testID={`${testID}.lastCount`}>
            {counted === null
              ? tm('money.kas.notCounted')
              : tm('money.kas.counted', { time: formatTime(counted.countedAt) })}
          </Text>
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

      {difference === null ? null : (
        <Section title={tm('money.kas.difference')} testID={`${testID}.differences`}>
          <Row
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

      {entriesReady ? (
        <Section title={tm('money.kas.inToday')} testID={`${testID}.in`}>
          {methods.length === 0 ? (
            <Text style={styles.muted}>{tm('money.kas.nothingIn')}</Text>
          ) : (
            <>
              {methods.map((method) => (
                <Row
                  key={method.account}
                  label={accountLabel(method.account, accountRows)}
                  value={formatMoney(method.amount)}
                  testID={`${testID}.in.${method.account}`}
                />
              ))}
              <Row
                label={tm('money.kas.total')}
                value={formatMoney(methods.reduce((sum, method) => sum + method.amount, 0))}
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
            <Row
              key={entry.id}
              label={tm(label)}
              detail={[formatTime(entry.createdAt), entry.reason].filter(Boolean).join(' · ')}
              value={`${delta < 0 ? '−' : '+'}${formatMoney(Math.abs(delta))}`}
              testID={`${testID}.moves.${entry.id}`}
            />
          ))}
        </Section>
      )}

      {open.owed.length === 0 ? null : (
        <Section title={tm('money.kas.owed')} testID={`${testID}.owed`}>
          {open.owed.map((row) => (
            <Row
              key={row.documentId}
              label={row.customer ?? row.documentLabel}
              detail={[
                row.customer === null ? null : row.documentLabel,
                tm('money.kas.since', { date: formatDate(row.since) }),
              ]
                .filter(Boolean)
                .join(' · ')}
              value={formatMoney(row.balance)}
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
            <Row
              key={row.documentId}
              label={row.customer ?? row.documentLabel}
              detail={row.customer === null ? undefined : row.documentLabel}
              value={formatMoney(-row.balance)}
              onPress={mayReceive ? () => onRefund(row) : undefined}
              testID={`${testID}.owedBack.${row.documentId}`}
            />
          ))}
        </Section>
      )}
    </AppShell>
  );
}

/** A label (and a line under it) left, its amount right; a chevron when it opens a step. */
export function Row({
  label,
  detail,
  value,
  tone = 'text',
  strong = false,
  onPress,
  testID,
}: {
  readonly label: string;
  readonly detail?: string | undefined;
  readonly value: string;
  /** `struck`: a record that no longer counts (a cancelled payment). */
  readonly tone?: 'text' | 'danger' | 'struck' | undefined;
  readonly strong?: boolean | undefined;
  readonly onPress?: (() => void) | undefined;
  readonly testID: string;
}): React.JSX.Element {
  const body: ReactNode = (
    <>
      <View style={styles.rowText}>
        <Text style={strong ? styles.rowLabelStrong : styles.rowLabel}>{label}</Text>
        {detail === undefined || detail === '' ? null : (
          <Text style={styles.rowDetail}>{detail}</Text>
        )}
      </View>
      <Text
        style={[
          strong ? styles.rowValueStrong : styles.rowValue,
          tone === 'danger' && styles.danger,
          tone === 'struck' && styles.struck,
        ]}
        testID={`${testID}.value`}
      >
        {value}
      </Text>
      {onPress === undefined ? null : <Icon name="chevron" size={20} color={color.textMuted} />}
    </>
  );
  return onPress === undefined ? (
    <View style={[styles.row, strong && styles.totalRow]} testID={testID}>
      {body}
    </View>
  ) : (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={testID}
    >
      {body}
    </Pressable>
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
    fontVariant: ['tabular-nums'],
    marginTop: space.xs,
  },
  muted: { ...type.bodySm, color: color.textMuted, marginTop: space.xs },
  drawerAction: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  row: {
    minHeight: touch.min,
    paddingVertical: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderBottomWidth: border.hairline,
    borderBottomColor: color.border,
  },
  totalRow: { borderBottomWidth: 0 },
  pressed: { backgroundColor: color.surfaceAlt },
  rowText: { flex: 1 },
  rowLabel: { ...type.bodySm, color: color.text },
  rowLabelStrong: { ...type.bodyBold, color: color.text },
  rowDetail: { ...type.caption, color: color.textMuted, marginTop: space.xs },
  rowValue: { ...type.bodySm, fontWeight: '600', color: color.text, fontVariant: ['tabular-nums'] },
  rowValueStrong: { ...type.bodyBold, color: color.text, fontVariant: ['tabular-nums'] },
  danger: { color: color.danger },
  struck: { color: color.textMuted, textDecorationLine: 'line-through' },
});
