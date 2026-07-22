/**
 * Sync Status (design-system §8.4) — the app's honesty surface.
 *
 * The distinction it exists to draw (offline-and-fine vs actually-broken) is argued in `model.ts`.
 * What this file contributes is the ORDER, which is where that argument becomes visible:
 *
 *   1. THE ANSWER — "is my work safe?" That is the only question anyone opens this screen with, so
 *      it is the first thing on it, in `type.display`. In every state but `attention` the answer is
 *      yes, and it is stated as a fact rather than implied by the absence of an error.
 *   2. FRESHNESS — the FreshnessCell + "last connected …". Not "are you online" (nobody cares) but
 *      "is what I am looking at current" (everybody does). This is the honest escalation.
 *   3. COUNTERS — receipts. Neutral. `sync.status.pending` is "3 perubahan belum terkirim", which
 *      is the app telling you it is holding your work, not confessing to losing it.
 *   4. PROBLEMS — rejected / quarantined, and ONLY when they exist. An empty problems list renders
 *      nothing at all: no "0 rejected", no green all-clear badge. A section that is usually empty
 *      trains people to skim past it, and this is the one section that must never be skimmed.
 *
 * The HEADER TITLE is part of that argument, not chrome above it: it names the state the device is
 * actually in (`SYNC_TITLE_KEY`, model.ts). A fixed title cannot be honest on this screen — a title
 * that says "Rejected Changes" over "everything is sent" is the screen contradicting itself in its
 * largest text, and the largest text wins.
 *
 * Offline appears exactly once, at tier 1, phrased as `sync.status.offline` — "Tidak ada koneksi.
 * Perubahan tersimpan di perangkat ini." It is a statement about the network AND a reassurance about
 * the data, in that order, in one sentence. It is never red.
 */
import { formatRelative, t, translateRejectionCode } from '@bolusi/i18n';
import {
  AppShell,
  AvatarButton,
  Banner,
  Button,
  Card,
  Chip,
  FreshnessCell,
  List,
  ListRow,
  SyncChip,
  color,
  numeric,
  selectBanner,
  space,
  type,
  type ListState,
} from '@bolusi/ui';
import { StyleSheet, Text, View, type TextStyle } from 'react-native';

import {
  bannerCauses,
  isOfflineButHealthy,
  manualSync,
  mediaQueue,
  MEDIA_STATUS_KEY,
  reassurance,
  REASSURANCE_KEY,
  showsRejectedSection,
  staleness,
  SYNC_TITLE_KEY,
  syncChipState,
  syncProblems,
  syncTitleState,
  type MediaQueueRow,
  type RejectedOpRow,
  type SyncStatusInput,
} from './model.js';

export interface SyncStatusScreenProps {
  readonly input: SyncStatusInput;
  readonly currentUser: { readonly id: string; readonly initials: string } | null;
  readonly onBack: () => void;
  readonly onSyncNow: () => void;
  readonly onOpenRejected: (row: RejectedOpRow) => void;
  readonly onRetryMedia: (row: MediaQueueRow) => void;
  readonly onOpenSwitcher: () => void;
}

export function SyncStatusScreen({
  input,
  currentUser,
  onBack,
  onSyncNow,
  onOpenRejected,
  onRetryMedia,
  onOpenSwitcher,
}: SyncStatusScreenProps): React.JSX.Element {
  const level = staleness(input);
  const banner = selectBanner(bannerCauses(input));
  const sync = manualSync(input);
  const queue = mediaQueue(input);
  const problems = syncProblems(input);
  // The header chip is the five-state, media-blind verdict (design-system §8.1). The header title is
  // that verdict PLUS the `photosPending` distinction the chip cannot carry (task 147): they agree
  // whenever anything is wrong, and diverge only when ops are sent while photos are still queued.
  const chip = syncChipState(input);
  const titleState = syncTitleState(input);

  const rejectedState: ListState<RejectedOpRow> = { kind: 'ready', items: [...input.rejected] };
  const mediaState: ListState<MediaQueueRow> = { kind: 'ready', items: [...queue] };

  return (
    <AppShell
      // task 126/147: the title is the STATE, read from `SYNC_TITLE_KEY` (model.ts) — the one
      // view→key mapping (§2.8). Keyed on `syncTitleState`, which is the chip's verdict plus the one
      // distinction the media-blind chip cannot draw: ops sent, photos still queued (FR-1138). Before
      // 126 it was `t('sync.rejected.title')` unconditionally (a synced device headed "Perubahan
      // Ditolak"); 126 keyed it on the chip, which then read "Semua Terkirim" over 3 pending photos.
      title={t(SYNC_TITLE_KEY[titleState])}
      titleVariant="detail"
      onBack={onBack}
      backLabel={t('core.action.back')}
      syncChip={
        <SyncChip
          state={chip}
          pendingCount={input.pendingOperationCount}
          accessibilityLabel={t('sync.status.lastSynced', { relative: relativeLabel(input) })}
          onPress={onBack}
        />
      }
      avatar={
        currentUser === null ? (
          <View testID="sync-no-avatar" />
        ) : (
          <AvatarButton
            userId={currentUser.id}
            initials={currentUser.initials}
            accessibilityLabel={t('auth.switcher.title')}
            onPress={onOpenSwitcher}
          />
        )
      }
      banner={
        banner === null ? undefined : (
          <Banner
            variant={banner.variant}
            message={bannerMessage(input, banner.cause.kind)}
            suppressedCount={banner.suppressedCount}
            leadingGlyph={
              banner.cause.kind === 'staleness' ? <FreshnessCell level={level} /> : undefined
            }
            testID="sync-banner"
          />
        )
      }
      bottomAction={
        <Button
          label={t('sync.action.syncNow')}
          onPress={onSyncNow}
          busy={sync.kind === 'busy'}
          disabled={sync.kind === 'disabled'}
          testID="sync-now"
        />
      }
      testID="sync-status-screen"
    >
      {/* 1 — THE ANSWER. */}
      <View style={styles.answer} testID="sync-reassurance">
        <FreshnessCell
          level={level}
          accessibilityLabel={t('sync.status.lastSynced', { relative: relativeLabel(input) })}
        />
        <Text style={styles.answerText} testID="sync-reassurance-text">
          {reassuranceText(input)}
        </Text>
      </View>

      {/* 2 — FRESHNESS. */}
      <Text style={styles.meta} testID="sync-last-synced">
        {t('sync.status.lastSynced', { relative: relativeLabel(input) })}
      </Text>

      {/* 3 — RECEIPTS. Neutral by construction: Chips, `textMuted`, no danger tone anywhere. */}
      <View style={styles.counters} testID="sync-counters">
        <Card testID="sync-counter-ops">
          <Text style={styles.count}>{String(input.pendingOperationCount)}</Text>
          <Text style={styles.meta}>
            {t('sync.status.pending', { count: input.pendingOperationCount })}
          </Text>
        </Card>
        <Card testID="sync-counter-media">
          <Text style={styles.count}>{String(input.pendingMediaCount)}</Text>
          <Text style={styles.meta}>
            {t('sync.status.pendingMedia', { count: input.pendingMediaCount })}
          </Text>
        </Card>
      </View>

      {sync.kind === 'disabled' ? (
        // A disabled button with no reason is how a user decides the app is broken.
        <Text style={styles.disabledReason} testID="sync-disabled-reason">
          {translateRejectionCode('DEVICE_REVOKED')}
        </Text>
      ) : null}

      {input.manualSyncError !== null ? (
        // §8.4 item 3: inline, never modal — the backoff continues in the background regardless.
        <Text style={styles.inlineError} testID="sync-manual-error">
          {t('core.errors.NETWORK')}
        </Text>
      ) : null}

      {/* 4 — PROBLEMS, only when real. */}
      {problems.some((problem) => problem.kind === 'quarantined') ? (
        <View testID="sync-quarantine">
          <Text style={styles.sectionDanger}>{t('sync.quarantine.title')}</Text>
          <Text style={styles.meta}>{t('sync.quarantine.body')}</Text>
        </View>
      ) : null}

      {showsRejectedSection(input) ? (
        <View testID="sync-rejected-section">
          <Text style={styles.sectionDanger}>{t('sync.rejected.title')}</Text>
          <Text style={styles.meta}>{t('sync.rejected.explain')}</Text>
          <List
            state={rejectedState}
            keyExtractor={(row) => row.opId}
            renderRow={(row) => (
              <ListRow
                primaryText={translateRejectionCode(row.rejectionCode)}
                secondaryText={formatRelative(input.now - row.at)}
                onPress={() => onOpenRejected(row)}
                showChevron
                testID={`sync-rejected-${row.opId}`}
              />
            )}
            testID="sync-rejected-list"
          />
        </View>
      ) : null}

      {queue.length > 0 ? (
        <View testID="sync-media-section">
          <List
            state={mediaState}
            keyExtractor={(row) => row.mediaId}
            renderRow={(row) => (
              <ListRow
                primaryText={t(MEDIA_STATUS_KEY[row.uploadStatus])}
                secondaryText={row.progressPercent === null ? undefined : `${row.progressPercent}%`}
                trailing={
                  <Chip
                    label={t(MEDIA_STATUS_KEY[row.uploadStatus])}
                    icon={row.uploadStatus === 'failed' ? 'rejected' : 'pending'}
                    tone={row.uploadStatus === 'failed' ? 'danger' : 'neutral'}
                    {...(row.uploadStatus === 'failed' ? { onPress: () => onRetryMedia(row) } : {})}
                  />
                }
                testID={`sync-media-${row.mediaId}`}
              />
            )}
            testID="sync-media-list"
          />
        </View>
      ) : null}
    </AppShell>
  );
}

/** `{relative}` arrives PRE-FORMATTED (07-i18n): the formatter is i18n's, never Intl here. */
function relativeLabel(input: SyncStatusInput): string {
  if (input.state.lastSuccessfulSyncAt === null) return t('core.status.empty');
  return formatRelative(input.now - input.state.lastSuccessfulSyncAt);
}

/**
 * Tier 1's sentence — the answer to "is my work safe?".
 *
 * The key per `Reassurance` kind is read from `REASSURANCE_KEY` (model.ts), the ONE view→key mapping
 * (§2.8); this function supplies only the per-arm params. That makes `model.test.ts`'s
 * `REASSURANCE_KEY` assertions load-bearing rather than a decoy (task 65) — break a slot and both
 * this line AND those tests change. `offline-but-healthy` is handled BEFORE the map because it is not
 * a `Reassurance` kind at all: offline is an input, never a problem (model.ts's thesis), so it has
 * its own one-sentence copy.
 */
function reassuranceText(input: SyncStatusInput): string {
  if (isOfflineButHealthy(input)) return t('sync.status.offline');

  const answer = reassurance(input);
  switch (answer.kind) {
    case 'allSent':
      return t(REASSURANCE_KEY[answer.kind]);
    case 'savedHere':
      return t(REASSURANCE_KEY[answer.kind], { count: answer.pendingOperationCount });
    case 'photosPending':
      // Ops sent, photos still draining (FR-1138) — honest and calm, never "all sent".
      return t(REASSURANCE_KEY[answer.kind]);
    case 'syncing':
      return t(REASSURANCE_KEY[answer.kind]);
    case 'attention':
      return t(REASSURANCE_KEY[answer.kind], { count: input.rejected.length });
  }
}

/** The banner's already-localized message for the winning cause. */
function bannerMessage(input: SyncStatusInput, cause: string): string {
  if (cause === 'deviceRevoked') return t('auth.revoked.body');
  if (cause === 'rejectedOps') return t('sync.rejected.banner', { count: input.rejected.length });
  return staleness(input) === 'stale'
    ? t('sync.banner.stale')
    : t('sync.banner.warning', { relative: relativeLabel(input) });
}

const styles = StyleSheet.create({
  answer: { alignItems: 'center', flexDirection: 'row', gap: space.md, marginBottom: space.sm },
  answerText: { ...type.heading, color: color.text, flex: 1 },
  meta: { ...type.caption, color: color.textMuted },
  counters: { flexDirection: 'row', gap: space.md, marginVertical: space.lg },
  // design-system §2: tabular figures so a ticking count does not jitter as it ticks.
  //
  // The cast is a `@bolusi/ui` nit, not a token bypass: `numeric` is
  // `Object.freeze({ fontVariant: Object.freeze(['tabular-nums']) } as const)`, and the inner
  // `Object.freeze` widens the tuple to `readonly string[]`, which RN's `TextStyle` (a literal
  // union) rejects. The VALUE is still the token's — nothing is restated here. Flagged for task 33:
  // dropping the inner freeze in tokens.ts fixes it for every consumer, but `packages/ui` is
  // contended this wave (CLAUDE.md §4) and `numeric` has no other consumer yet, so this screen is
  // the first to hit it.
  count: {
    ...type.display,
    color: color.text,
    fontVariant: numeric.fontVariant as TextStyle['fontVariant'],
  },
  sectionDanger: { ...type.heading, color: color.danger, marginTop: space.xl },
  inlineError: { ...type.bodySm, color: color.danger, marginTop: space.sm },
  disabledReason: { ...type.bodySm, color: color.textMuted, marginTop: space.sm },
});
