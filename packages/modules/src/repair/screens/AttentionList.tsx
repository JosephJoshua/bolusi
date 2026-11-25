/**
 * AttentionList — Perlu dicek, the first place of an owner or Manajer: the requests they may
 * answer, oldest first, each opening straight on its answer; then what else waits on them across
 * the store, as counts that open the list where it is worked off. Only what has something in it
 * shows; with nothing waiting the screen says so.
 */
import { formatRelative } from '@bolusi/i18n';
import {
  AppShell,
  EmptyState,
  FreshGlow,
  Icon,
  ListRow,
  Text,
  bleedMargins,
  bleedPadding,
  border,
  color,
  numeric,
  size,
  space,
  touch,
  type,
  useBleed,
  type IconName,
} from '@bolusi/ui';
import { approvalKindKey, ta } from '../../approvals/i18n.js';
import { useTick } from '../../screen-kit/index.js';
import { QueryView, Section, type ScreenChrome } from '../../screen-kit/screens/views.js';
import { describeRepairApproval } from '../approval-copy.js';
import {
  ATTENTION_COUNTS,
  ATTENTION_COUNT_KEY,
  attentionCount,
  attentionEmpty,
  readAttention,
  type AttentionCount,
  type AttentionRequest,
} from '../attention.js';
import { UNCOLLECTED_REFRESH_MS } from '../flows.js';
import { tn } from '../i18n.js';
import { useRepairQuery } from '../runtime.js';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

export interface AttentionListProps {
  readonly chrome: ScreenChrome;
  /** The clock requests' age and phones' wait are read against. */
  readonly now: () => number;
  /** This person's own changes the server refused, still to be looked at (the shell knows them). */
  readonly refused: number;
  readonly onOpenRequest: (row: AttentionRequest) => void;
  readonly onOpenList: (list: AttentionCount) => void;
  readonly onOpenSyncStatus: () => void;
  readonly testID?: string | undefined;
}

const ICON: Readonly<Record<AttentionCount, IconName>> = {
  uncollected: 'clock',
  belowZero: 'parts',
  partlyReceived: 'buy',
  refused: 'rejected',
};

export function AttentionList({
  chrome,
  now,
  refused,
  onOpenRequest,
  onOpenList,
  onOpenSyncStatus,
  testID = 'attention',
}: AttentionListProps): React.JSX.Element {
  const [reloadNonce, setReloadNonce] = useState(0);
  // A phone passes into "not collected" with nobody touching anything, so read again now and then.
  const hour = useTick(UNCOLLECTED_REFRESH_MS);
  const query = useRepairQuery(
    (rt) => readAttention(rt, now()),
    `attention:${String(reloadNonce)}:${String(hour)}`,
  );
  const bleed = useBleed();
  const readAt = now();

  return (
    <AppShell
      title={tn('repair.attention.title')}
      titleVariant="root"
      syncChip={chrome.syncChip}
      avatar={chrome.avatar}
      testID={testID}
    >
      <QueryView
        query={query}
        onBack={onOpenSyncStatus}
        onRetry={() => setReloadNonce((n) => n + 1)}
        testID={testID}
      >
        {(attention) => {
          if (attentionEmpty(attention, refused)) {
            return (
              <EmptyState
                title={tn('repair.attention.empty')}
                hint={tn('repair.attention.emptyHint')}
                testID={`${testID}.empty`}
              />
            );
          }
          const lists = ATTENTION_COUNTS.map((key) => ({
            key,
            count: attentionCount(key, attention, refused),
          })).filter((list) => list.count > 0);
          return (
            <>
              {attention.requests.length === 0 ? null : (
                <Section
                  first
                  title={tn('repair.attention.requests', { count: attention.requests.length })}
                  testID={`${testID}.requests`}
                >
                  <View style={bleedMargins(bleed)}>
                    {attention.requests.map((row) => (
                      <RequestRow
                        key={row.request.id}
                        row={row}
                        readAt={readAt}
                        onOpen={onOpenRequest}
                        testID={`${testID}.request.${row.request.id}`}
                      />
                    ))}
                  </View>
                </Section>
              )}
              {lists.length === 0 ? null : (
                <Section
                  first={attention.requests.length === 0}
                  title={tn('repair.attention.elsewhere')}
                  testID={`${testID}.lists`}
                >
                  <View style={bleedMargins(bleed)}>
                    {lists.map((list) => (
                      <ListRow
                        key={list.key}
                        leading={
                          <Icon name={ICON[list.key]} size={size.iconInline} color={color.text} />
                        }
                        primaryText={tn(ATTENTION_COUNT_KEY[list.key])}
                        trailing={<Text style={styles.count}>{String(list.count)}</Text>}
                        onPress={() => onOpenList(list.key)}
                        bleed={bleed}
                        testID={`${testID}.list.${list.key}`}
                      />
                    ))}
                  </View>
                </Section>
              )}
            </>
          );
        }}
      </QueryView>
    </AppShell>
  );
}

/**
 * One request: what it is and what it is worth on the first line, the servisan it is on under it,
 * then who asked, why, and how long ago. Tapping opens the answer itself.
 */
function RequestRow({
  row,
  readAt,
  onOpen,
  testID,
}: {
  readonly row: AttentionRequest;
  readonly readAt: number;
  readonly onOpen: (row: AttentionRequest) => void;
  readonly testID: string;
}): React.JSX.Element {
  const bleed = useBleed();
  const { request, ticket } = row;
  const description = describeRepairApproval(request);
  const kind = ta(approvalKindKey(request.kind));
  const on =
    ticket === null
      ? null
      : [
          ticket.ticketNumber,
          ticket.customerName,
          [ticket.deviceBrand, ticket.deviceModel].filter((s) => s !== '').join(' '),
        ]
          .filter((s) => s !== '')
          .join(' · ');
  const asked = ta('approvals.row.askedBy', {
    name: request.requestedByName ?? '–',
    reason: request.reason,
  });
  const age = formatRelative(Math.max(0, readAt - request.requestedAt));
  const label = [kind, description.amount ?? '', on ?? '', asked, age]
    .filter((s) => s !== '')
    .join(', ');
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => onOpen(row)}
      android_ripple={{ color: color.surfaceAlt }}
      style={({ pressed }) => [
        styles.row,
        bleedPadding(bleed),
        { backgroundColor: pressed ? color.surfaceAlt : color.surface },
      ]}
    >
      <FreshGlow id={request.id} testID={`${testID}.fresh`} />
      <View style={styles.line}>
        <Text style={styles.kind}>{kind}</Text>
        {description.amount === null ? null : (
          <Text style={styles.amount} testID={`${testID}.amount`}>
            {description.amount}
          </Text>
        )}
      </View>
      {on === null ? null : <Text style={styles.on}>{on}</Text>}
      <View style={styles.line}>
        <Text style={styles.asked}>{asked}</Text>
        <Text style={styles.age}>{age}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: touch.rowMin,
    paddingVertical: space.md,
    gap: space.xs,
    borderBottomWidth: border.hairline,
    borderBottomColor: color.border,
  },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  kind: { ...type.bodyBold, color: color.text, flex: 1 },
  amount: { ...type.bodySm, fontWeight: '600', color: color.text, ...numeric },
  on: { ...type.bodySm, color: color.text },
  asked: { ...type.bodySm, color: color.textMuted, flex: 1 },
  age: { ...type.caption, color: color.textMuted },
  count: { ...type.bodySm, fontWeight: '600', color: color.text, ...numeric },
});
