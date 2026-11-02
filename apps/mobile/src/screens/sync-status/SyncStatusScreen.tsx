/**
 * Sync Status (design-system §8.4) — the app's honesty surface.
 *
 * The distinction it exists to draw (offline-and-fine vs actually-broken) is argued in `model.ts`.
 * What this file contributes is the ORDER, which is where that argument becomes visible:
 *
 *   1. THE ANSWER — "is my work safe?" That is the only question anyone opens this screen with, so
 *      it is the first thing on it, in `type.display`. In every state but `attention` the answer is
 *      yes, and it is stated as a fact rather than implied by the absence of an error.
 *   2. FRESHNESS — "last connected …" under the answer. Not "are you online" (nobody cares) but
 *      "is what I am looking at current" (everybody does). This is the honest escalation.
 *   3. WHAT IS WAITING — changes and photos not sent yet, and ONLY when there are some: a box of
 *      zeros said nothing the headline had not already said.
 *   4. PROBLEMS — rejected / quarantined, and ONLY when they exist. An empty problems list renders
 *      nothing at all: no "0 rejected", no green all-clear badge. A section that is usually empty
 *      trains people to skim past it, and this is the one section that must never be skimmed.
 *
 * The HEADLINE names the state the device is actually in (`SYNC_TITLE_KEY`, model.ts), in the
 * largest text on the screen, under a neutral header ("Status data"). A fixed headline cannot be
 * honest here — "Rejected Changes" over "everything is sent" is the screen contradicting itself.
 *
 * Offline appears exactly once, at tier 1, phrased as `sync.status.offline` — "Tidak ada koneksi.
 * Perubahan tersimpan di perangkat ini." It is a statement about the network AND a reassurance about
 * the data, in that order, in one sentence. It is never red.
 */
import {
  formatDate,
  formatRelative,
  t,
  translateErrorCode,
  translateOpType,
  translateRejection,
  translateRejectionCode,
} from '@bolusi/i18n';
import {
  AppShell,
  AvatarButton,
  Banner,
  Button,
  Fact,
  FactGrid,
  FreshnessCell,
  Icon,
  ListRow,
  Sheet,
  SyncChip,
  TextButton,
  border,
  color,
  radius,
  selectBanner,
  size,
  space,
  type,
  type IconName,
  Text,
} from '@bolusi/ui';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { UpdateCheckResult } from '../../bootstrap/app-updates.js';

import { syncChipAccessibilityLabels } from './chip-a11y.js';
import {
  bannerCauses,
  firstSyncPercent,
  manualSync,
  manualSyncErrorShown,
  mediaQueue,
  reassuranceMessage,
  relativeLabel,
  showsRejectedSection,
  staleness,
  SYNC_TITLE_KEY,
  syncChipState,
  syncLead,
  syncProblems,
  syncTitleState,
  type RejectedOpRow,
  type SyncStatusInput,
  type SyncTitleState,
} from '@bolusi/device/models/sync-status/model';

export interface SyncStatusScreenProps {
  readonly input: SyncStatusInput;
  readonly currentUser: { readonly id: string; readonly initials: string } | null;
  readonly onBack: () => void;
  readonly onSyncNow: () => void;
  /** Open (or close, when it is the open one) a refused change's detail sheet. */
  readonly onOpenRejected: (row: RejectedOpRow) => void;
  /** Re-sends every failed photo: the drain is one loop over all of them (06 §5.2 (e)). */
  readonly onRetryMedia: () => void;
  /** The person has dealt with the refused changes listed; they stop asking for attention. */
  readonly onMarkRejectedHandled?: ((opIds: readonly string[]) => void) | undefined;
  readonly onOpenSwitcher: () => void;
  /** Open device setup to register this phone again (offered only when the server forgot it). */
  readonly onReenroll: () => void;
  /**
   * Fetch and restart into a newer app version, offered while a change from a newer app holds the
   * pull. Absent in builds without over-the-air updates; the section then only explains.
   */
  readonly onCheckForUpdate?: (() => Promise<UpdateCheckResult>) | undefined;
  /**
   * The refused change whose detail sheet is open, or `null`. The row already says what happened and
   * what to do (`core.rejection.<CODE>`, 07-i18n §10.2); the sheet adds which change it was, when, and
   * the server's own words as collapsed technical detail (07-i18n §4.3).
   */
  readonly expandedRejectedOpId: string | null;
}

/** How many refused changes are listed at a time; "show more" adds this many again. */
export const REJECTED_SHOWN = 50;

export function SyncStatusScreen({
  input,
  currentUser,
  onBack,
  onSyncNow,
  onOpenRejected,
  onRetryMedia,
  onMarkRejectedHandled,
  onOpenSwitcher,
  onReenroll,
  onCheckForUpdate,
  expandedRejectedOpId,
}: SyncStatusScreenProps): React.JSX.Element {
  const level = staleness(input);
  // The refused-changes banner points here, so on this screen it would only repeat the headline
  // and the section below it.
  const banner = selectBanner(bannerCauses(input).filter((cause) => cause.kind !== 'rejectedOps'));
  const sync = manualSync(input);
  const queue = mediaQueue(input);
  const problems = syncProblems(input);
  const manualError = manualSyncErrorShown(input);
  const updateNeeded = problems.some((problem) => problem.kind === 'appUpdateNeeded');
  // The header chip is the five-state, media-blind verdict (design-system §8.1). The headline is that
  // verdict PLUS the `photosPending` distinction the chip cannot carry (task 147).
  const chip = syncChipState(input);
  const titleState = syncTitleState(input);
  const setupPercent = input.firstSync === null ? null : firstSyncPercent(input.firstSync);
  // A phone the server refuses cannot upload either, and "Kirim ulang foto" cannot fix that: the
  // photos go up once it is enrolled again, so the device problem is the one thing said.
  const deviceRefused = problems.some(
    (problem) => problem.kind === 'deviceUnrecognised' || problem.kind === 'deviceRevoked',
  );
  const failedPhotos = deviceRefused ? [] : queue.filter((row) => row.uploadStatus === 'failed');
  // The canonical count (06 §4: orphans never count), the same one the headline reads; failed photos
  // are still waiting, and their own section below says why.
  const waitingPhotos = input.pendingMediaCount;
  const hasWaiting = input.pendingOperationCount > 0 || waitingPhotos > 0;
  const openRejected = input.rejected.find((row) => row.opId === expandedRejectedOpId) ?? null;
  const [rejectedShown, setRejectedShown] = useState(REJECTED_SHOWN);
  // Collapsed again for each refused change opened.
  const [technicalFor, setTechnicalFor] = useState<string | null>(null);
  const technicalShown = openRejected !== null && technicalFor === openRejected.opId;
  const [updateCheck, setUpdateCheck] = useState<'idle' | 'checking' | 'none' | 'failed'>('idle');
  const checkForUpdate = (): void => {
    if (onCheckForUpdate === undefined) return;
    setUpdateCheck('checking');
    onCheckForUpdate().then(
      (result) => setUpdateCheck(result === 'none' ? 'none' : 'checking'),
      () => setUpdateCheck('failed'),
    );
  };
  const rejectedHidden = input.rejected.length - rejectedShown;
  // One filled action (design guide §2): checking refused changes when there are some, sending when
  // work waits, and otherwise none. "Kirim sekarang" then stays as a quiet link under the freshness
  // line, where pressing it to check the connection still makes sense.
  const lead = syncLead(input, onMarkRejectedHandled !== undefined);
  const markHandled = (): void => onMarkRejectedHandled?.(input.rejected.map((row) => row.opId));
  const { icon, tone } = HERO[titleState];

  return (
    <AppShell
      // Plain views: the refused list grows in pages (`REJECTED_SHOWN`), so the whole page scrolls.
      scrollable
      title={t('sync.status.screenTitle')}
      titleVariant="detail"
      onBack={onBack}
      backLabel={t('core.action.back')}
      syncChip={
        <SyncChip
          state={chip}
          pendingCount={input.pendingOperationCount}
          progressPercent={setupPercent}
          accessibilityLabels={syncChipAccessibilityLabels({
            relative: relativeLabel(input),
            pendingCount: input.pendingOperationCount,
            firstSyncPercent: setupPercent,
          })}
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
        lead === 'reenroll' ? (
          <Button
            label={t('auth.unrecognised.action')}
            onPress={onReenroll}
            testID="sync-reenroll"
          />
        ) : lead === 'markHandled' ? (
          <Button
            label={t('sync.rejected.handled')}
            onPress={markHandled}
            testID="sync-rejected-handled"
          />
        ) : lead === 'syncNow' ? (
          <View>
            {sync.kind === 'disabled' ? (
              // A disabled button with no reason is how a user decides the app is broken. The reason
              // comes from the MODEL's `reasonCode` (task 144 item 1).
              <Text style={styles.disabledReason} testID="sync-disabled-reason">
                {translateRejectionCode(sync.reasonCode)}
              </Text>
            ) : null}
            <Button
              label={t('sync.action.syncNow')}
              onPress={onSyncNow}
              busy={sync.kind === 'busy'}
              disabled={sync.kind === 'disabled'}
              testID="sync-now"
            />
          </View>
        ) : undefined
      }
      overlay={
        openRejected === null ? null : (
          <Sheet
            title={translateOpType(openRejected.type)}
            subtitle={
              openRejected.subject === null
                ? formatRelative(input.now - openRejected.at)
                : `${openRejected.subject} · ${formatRelative(input.now - openRejected.at)}`
            }
            closeLabel={t('core.action.close')}
            onClose={() => onOpenRejected(openRejected)}
            testID={`sync-rejected-detail-${openRejected.opId}`}
          >
            <Text style={styles.sheetBody}>
              {translateRejection(openRejected.rejectionCode, openRejected.rejectionReason)}
            </Text>
            {/* The code and the server's own words are for whoever helps the shop, never read at the
                counter (design guide §8), so they wait behind a link (07-i18n §4.3). */}
            <View style={styles.technicalToggle}>
              <TextButton
                label={t(
                  technicalShown ? 'sync.rejected.technicalHide' : 'sync.rejected.technicalDetails',
                )}
                onPress={() => setTechnicalFor(technicalShown ? null : openRejected.opId)}
                testID={`sync-rejected-technical-${openRejected.opId}`}
              />
            </View>
            {technicalShown ? (
              <View style={styles.technical}>
                <Text
                  style={styles.technicalText}
                  selectable
                  testID={`sync-rejected-code-${openRejected.opId}`}
                >
                  {openRejected.rejectionCode}
                </Text>
                {/* The server's own words, and ONLY here (07-i18n §4.3). */}
                <Text
                  style={styles.technicalText}
                  selectable
                  testID={`sync-rejected-reason-${openRejected.opId}`}
                >
                  {openRejected.rejectionReason ?? t('sync.rejected.noReason')}
                </Text>
              </View>
            ) : null}
          </Sheet>
        )
      }
      testID="sync-status-screen"
    >
      {/* 1 — THE ANSWER, then 2 — how fresh it is. */}
      <View style={styles.hero} testID="sync-reassurance">
        <View style={[styles.heroDisc, { backgroundColor: TONE[tone].bg }]}>
          <Icon name={icon} size={size.iconInline + space.xs} color={TONE[tone].fg} />
        </View>
        <View style={styles.heroText}>
          <Text style={styles.headline} accessibilityRole="header" testID="sync-headline">
            {t(SYNC_TITLE_KEY[titleState])}
          </Text>
          <Text style={styles.answer} testID="sync-reassurance-text">
            {reassuranceMessage(input, 'phone')}
          </Text>
          <Text style={styles.meta} testID="sync-last-synced">
            {/* While a newer app holds the pull, pushes still reach the server: "last connected"
                would read as offline, so say what actually stopped. */}
            {t(updateNeeded ? 'sync.updateNeeded.lastArrived' : 'sync.status.lastSynced', {
              relative: relativeLabel(input),
            })}
          </Text>
          {lead === 'syncNow' || lead === 'reenroll' ? null : (
            <View style={styles.sectionAction}>
              <TextButton
                label={t('sync.action.syncNow')}
                icon="retry"
                onPress={onSyncNow}
                disabled={sync.kind !== 'ready'}
                testID="sync-now"
              />
            </View>
          )}
        </View>
      </View>

      {input.firstSync !== null && setupPercent !== null ? (
        // A new device's first pull. Calm on purpose: it is setup, not a fault, and work can go on.
        <View style={styles.box} testID="sync-first-sync">
          <Text style={styles.boxTitle}>{t('sync.firstSync.title')}</Text>
          <Text style={styles.meta} testID="sync-first-sync-progress">
            {t('sync.firstSync.progress', {
              date: formatDate(input.firstSync.reachedAt),
              percent: setupPercent,
            })}
          </Text>
          <Text style={styles.meta}>{t('sync.firstSync.explain')}</Text>
        </View>
      ) : null}

      {/* 3 — WHAT IS WAITING, only when something is. Neutral: held work is safe work. */}
      {hasWaiting ? (
        <View style={styles.box} testID="sync-counters">
          <FactGrid>
            {/* A zero says nothing the headline has not, so only what is waiting is listed. */}
            {input.pendingOperationCount > 0 ? (
              <Fact
                label={t('sync.status.changesLabel')}
                value={t('sync.status.waitingCount', { count: input.pendingOperationCount })}
                wide={waitingPhotos === 0}
                testID="sync-counter-ops"
              />
            ) : null}
            {waitingPhotos > 0 ? (
              <Fact
                label={t('sync.status.photosLabel')}
                value={t('sync.status.waitingCount', { count: waitingPhotos })}
                wide={input.pendingOperationCount === 0}
                testID="sync-counter-media"
              />
            ) : null}
          </FactGrid>
        </View>
      ) : null}

      {manualError !== null ? (
        // §8.4 item 3: inline, never modal — the backoff continues in the background regardless. The
        // raw code rides beneath the message so a shop owner has something to quote to support; a
        // plain connection problem has nothing to quote, so it shows the message alone.
        <View style={styles.inlineError} testID="sync-manual-error">
          <Text style={styles.inlineErrorText}>{translateErrorCode(manualError)}</Text>
          {manualError === 'NETWORK' ? null : (
            <Text style={styles.meta} testID="sync-manual-error-code">
              {manualError}
            </Text>
          )}
        </View>
      ) : null}

      {/* 4 — PROBLEMS, only when real. */}
      {problems.some((problem) => problem.kind === 'deviceUnrecognised') ? (
        <View style={styles.section} testID="sync-unrecognised">
          <Text style={styles.sectionTitle}>{t('auth.unrecognised.title')}</Text>
          <Text style={styles.sectionText}>{t('auth.unrecognised.body')}</Text>
        </View>
      ) : null}

      {failedPhotos.length > 0 ? (
        <View style={styles.section} testID="sync-media-section">
          <Text style={styles.sectionTitle}>{t('sync.media.failedTitle')}</Text>
          <Text style={styles.sectionText}>
            {t('sync.media.failedBody', { count: failedPhotos.length })}
          </Text>
          <View style={styles.sectionAction}>
            <TextButton
              label={t('sync.media.retry')}
              icon="retry"
              onPress={onRetryMedia}
              testID="sync-media-retry"
            />
          </View>
        </View>
      ) : null}

      {updateNeeded ? (
        <View style={styles.section} testID="sync-update-needed">
          <Text style={styles.sectionTitle}>{t('sync.updateNeeded.title')}</Text>
          <Text style={styles.sectionText}>{t('sync.updateNeeded.body')}</Text>
          {onCheckForUpdate === undefined ? null : (
            <View style={styles.sectionAction}>
              <TextButton
                label={t(
                  updateCheck === 'checking'
                    ? 'sync.updateNeeded.checking'
                    : 'sync.updateNeeded.check',
                )}
                icon="retry"
                onPress={checkForUpdate}
                disabled={updateCheck === 'checking'}
                testID="sync-update-check"
              />
            </View>
          )}
          {updateCheck === 'none' || updateCheck === 'failed' ? (
            <Text style={styles.sectionText} testID="sync-update-result">
              {t(updateCheck === 'none' ? 'sync.updateNeeded.none' : 'sync.updateNeeded.failed')}
            </Text>
          ) : null}
        </View>
      ) : null}

      {problems.some((problem) => problem.kind === 'quarantined') ? (
        <View style={styles.section} testID="sync-quarantine">
          <Text style={styles.sectionTitle}>{t('sync.quarantine.title')}</Text>
          <Text style={styles.sectionText}>{t('sync.quarantine.body')}</Text>
        </View>
      ) : null}

      {showsRejectedSection(input) ? (
        <View style={styles.section} testID="sync-rejected-section">
          <Text style={styles.sectionTitle}>
            {t('sync.rejected.title', { count: input.rejected.length })}
          </Text>
          <Text style={styles.sectionText}>{t('sync.rejected.explain')}</Text>
          <View style={styles.rows} testID="sync-rejected-list">
            {input.rejected.slice(0, rejectedShown).map((row) => (
              <ListRow
                key={row.opId}
                leading={
                  <View style={styles.rowIcon}>
                    <Icon name="rejected" size={size.iconInline} color={color.danger} />
                  </View>
                }
                // What happened and what to do (the code's catalog sentence), then which change it was
                // and when. `translateOpType` degrades an unknown type to "Change", never a raw id.
                primaryText={translateRejection(row.rejectionCode, row.rejectionReason)}
                secondaryText={
                  row.subject === null
                    ? t('sync.rejected.opMeta', {
                        opType: translateOpType(row.type),
                        time: formatRelative(input.now - row.at),
                      })
                    : t('sync.rejected.opMetaSubject', {
                        opType: translateOpType(row.type),
                        subject: row.subject,
                        time: formatRelative(input.now - row.at),
                      })
                }
                onPress={() => onOpenRejected(row)}
                testID={`sync-rejected-${row.opId}`}
              />
            ))}
          </View>
          {rejectedHidden > 0 ? (
            <View style={styles.sectionAction}>
              <TextButton
                label={t('sync.rejected.more', {
                  count: Math.min(rejectedHidden, REJECTED_SHOWN),
                })}
                onPress={() => setRejectedShown((shown) => shown + REJECTED_SHOWN)}
                testID="sync-rejected-more"
              />
            </View>
          ) : null}
        </View>
      ) : null}
    </AppShell>
  );
}

/** The headline's icon and tone per state. Only a real problem is coloured. */
const HERO: Record<SyncTitleState, { readonly icon: IconName; readonly tone: HeroTone }> = {
  synced: { icon: 'syncSynced', tone: 'success' },
  pending: { icon: 'pending', tone: 'neutral' },
  photosPending: { icon: 'photos', tone: 'neutral' },
  syncing: { icon: 'syncSyncing', tone: 'neutral' },
  offline: { icon: 'syncOffline', tone: 'neutral' },
  attention: { icon: 'warning', tone: 'warning' },
};

type HeroTone = 'success' | 'neutral' | 'warning';

const TONE: Record<HeroTone, { readonly bg: string; readonly fg: string }> = {
  success: { bg: color.successBg, fg: color.success },
  neutral: { bg: color.surfaceAlt, fg: color.textMuted },
  warning: { bg: color.warningBg, fg: color.warning },
};

/** The banner's already-localized message for the winning cause. */
function bannerMessage(input: SyncStatusInput, cause: string): string {
  if (cause === 'deviceRevoked') return t('auth.revoked.body');
  if (cause === 'info' && input.firstSync !== null) {
    return t('sync.firstSync.banner', { percent: firstSyncPercent(input.firstSync) });
  }
  if (cause === 'rejectedOps') return t('sync.rejected.banner', { count: input.rejected.length });
  return staleness(input) === 'stale'
    ? t('sync.banner.stale')
    : t('sync.banner.warning', { relative: relativeLabel(input) });
}

const styles = StyleSheet.create({
  hero: { flexDirection: 'row', gap: space.md, paddingTop: space.sm },
  heroDisc: {
    width: size.avatarRow,
    height: size.avatarRow,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroText: { flex: 1 },
  headline: { ...type.title, color: color.text },
  answer: { ...type.body, color: color.text, marginTop: space.xs },
  meta: { ...type.caption, color: color.textMuted, marginTop: space.xs },
  box: {
    backgroundColor: color.surfaceAlt,
    borderRadius: radius.md,
    padding: space.lg,
    marginTop: space.xl,
  },
  boxTitle: { ...type.bodyBold, color: color.text },
  inlineError: { marginTop: space.lg },
  inlineErrorText: { ...type.bodySm, color: color.danger },
  section: { marginTop: space.xl },
  sectionTitle: { ...type.bodyBold, color: color.text },
  sectionText: { ...type.bodySm, color: color.textMuted, marginTop: space.xs },
  sectionAction: { alignItems: 'flex-start', marginLeft: -space.sm, marginTop: space.xs },
  rows: {
    marginTop: space.md,
    marginHorizontal: -space.lg,
    borderTopWidth: border.hairline,
    borderTopColor: color.border,
  },
  rowIcon: {
    width: size.avatarRow,
    height: size.avatarRow,
    borderRadius: radius.full,
    backgroundColor: color.dangerBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabledReason: {
    ...type.bodySm,
    color: color.textMuted,
    marginBottom: space.sm,
    textAlign: 'center',
  },
  sheetBody: { ...type.body, color: color.text },
  technicalToggle: { alignItems: 'flex-start', marginLeft: -space.sm, marginTop: space.sm },
  technical: {
    backgroundColor: color.surfaceAlt,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.xs,
    marginTop: space.xs,
  },
  technicalText: { ...type.caption, color: color.text },
});
