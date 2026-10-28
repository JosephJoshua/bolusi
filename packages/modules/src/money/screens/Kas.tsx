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
  border,
  color,
  radius,
  space,
  touch,
  type,
} from '@bolusi/ui';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Section, type ScreenChrome } from '../../screen-kit/screens/views.js';
import type { QueryState } from '../../screen-kit/index.js';

import { MONEY_PERMISSION } from '../constants.js';
import { tm } from '../i18n.js';
import {
  accountLabel,
  countToday,
  differenceToSettle,
  dayStart,
  drawerMoves,
  moneyInByMethod,
  nameBalances,
  splitOpenBalances,
  type NamedBalance,
} from '../kas.js';
import type { CashCountRow, MoneyEntryRow } from '../queries.js';
import { useMoneyQuery, useMoneyRuntime } from '../runtime.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface KasBoardProps {
  readonly chrome: ScreenChrome;
  readonly now: () => number;
  readonly onCount: () => void;
  readonly onMove: () => void;
  readonly onSettle: (count: CashCountRow) => void;
  readonly onReceive: (balance: NamedBalance) => void;
  /** A tablet beside another pane shows no header of its own; absent on a phone. */
  readonly testID?: string | undefined;
}

/** A read this person may not make shows nothing, rather than a locked section. */
function readyOr<T>(query: QueryState<T>): T | null {
  return query.status === 'ready' ? query.data : null;
}

export function KasBoard({
  chrome,
  now,
  onCount,
  onMove,
  onSettle,
  onReceive,
  testID = 'money.kas',
}: KasBoardProps): React.JSX.Element {
  const runtime = useMoneyRuntime();
  const can = (permission: string) => runtime.hasPermission(permission);
  // Read each render, so a board shown again the next morning reads the new day.
  const today = dayStart(now());
  const drawer = useMoneyQuery(async (rt) => (await rt.query('cashDrawer', {})).rows[0]!, 'drawer');
  const entries = useMoneyQuery(
    async (rt) => {
      // Every record of the day, however busy it was: the totals are sums over all of them.
      const rows: MoneyEntryRow[] = [];
      let cursor: string | undefined;
      do {
        const page = await rt.query('moneyEntries', {
          from: today,
          to: today + DAY_MS,
          limit: 500,
          ...(cursor === undefined ? {} : { cursor }),
        });
        rows.push(...page.rows);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return rows;
    },
    `entries:${String(today)}`,
  );
  const accounts = useMoneyQuery(
    async (rt) => (await rt.query('paymentAccounts', { includeInactive: true })).rows,
    'accounts',
  );
  const balances = useMoneyQuery(async (rt) => {
    const { rows } = await rt.query('openBalances', {});
    return nameBalances(
      rows,
      await rt.customersOf(rows.map((row) => ({ kind: row.documentKind, id: row.documentId }))),
    );
  }, 'open');

  const drawerData = readyOr(drawer);
  const todayEntries = readyOr(entries) ?? [];
  const accountRows = readyOr(accounts) ?? [];
  const methods = moneyInByMethod(todayEntries);
  const moves = drawerMoves(todayEntries);
  const open = splitOpenBalances(readyOr(balances) ?? []);
  const difference = drawerData === null ? null : differenceToSettle(drawerData.counts);
  const counted = drawerData === null ? null : countToday(drawerData.counts, now());
  const mayCount = can(MONEY_PERMISSION.countCash);
  const maySettle = can(MONEY_PERMISSION.adjustCash);
  const mayReceive = can(MONEY_PERMISSION.receive);

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
          <Text style={styles.expected} testID={`${testID}.expected`}>
            {formatMoney(drawerData.expected)}
          </Text>
          <Text style={styles.muted} testID={`${testID}.lastCount`}>
            {counted === null
              ? tm('money.kas.notCounted')
              : tm('money.kas.counted', { time: formatTime(counted.countedAt) })}
          </Text>
          {can(MONEY_PERMISSION.moveCash) ? (
            <View style={styles.drawerAction}>
              <Button
                label={tm('money.kas.move')}
                variant="secondary"
                size="compact"
                onPress={onMove}
                testID={`${testID}.move`}
              />
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

      {entries.status === 'ready' ? (
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
              testID={`${testID}.owedBack.${row.documentId}`}
            />
          ))}
        </Section>
      )}
    </AppShell>
  );
}

/** "Kurang Rp 5.000" or "Lebih Rp 5.000": a count's difference as the counter says it. */
export function differenceText(difference: number): string {
  if (difference === 0) return tm('money.kas.exact');
  return tm(difference < 0 ? 'money.kas.short' : 'money.kas.over', {
    amount: formatMoney(Math.abs(difference)),
  });
}

/** A label (and a line under it) left, its amount right; a chevron when it opens a step. */
function Row({
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
  readonly tone?: 'text' | 'danger' | undefined;
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
  drawerAction: { flexDirection: 'row', marginTop: space.md },
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
});
