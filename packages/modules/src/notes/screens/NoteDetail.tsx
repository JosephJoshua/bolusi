/**
 * NoteDetail (design-system §8.6) — one note, its attachment, and its two actions.
 *
 * All four §5 states (a not-found note is the Empty state — the thing you asked for is not here;
 * a denied read is Unauthorized, never that Empty; any other failure is Error with retry). The
 * rejected-op DANGER BANNER renders inline here (design-system §3.6/§4.4, 05-operation-log §8): a
 * rejection is loud and never silent, and this is the detail surface where the owner sees it.
 *
 * Archive is destructive and goes through the ConfirmSheet (§3.10) — the single sanctioned modal —
 * then fires optimistically like every command (§4.1). The thumbnail is the media client's verified
 * output (06 §6): the screen displays a `local`/`cached` uri and renders the honest not-yet /
 * failed-verification states rather than a broken image.
 */
import { formatRelative, t, translateErrorCode } from '@bolusi/i18n';
import {
  AppShell,
  Banner,
  Button,
  Card,
  ConfirmSheet,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  UnauthorizedState,
  color,
  radius,
  size,
  space,
  type,
} from '@bolusi/ui';
import { Image } from 'expo-image';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { NoteRow } from '../queries.js';

import { tn } from './i18n.js';
import { hasRejectedOp } from './model.js';
import { useCommand, useQuery, useThumbnail, type NoteSyncStatuses } from './runtime.js';

export interface NoteDetailProps {
  readonly noteId: string;
  readonly now: number;
  readonly syncChip: ReactNode;
  readonly avatar: ReactNode;
  readonly onBack: () => void;
  readonly onEdit: (noteId: string) => void;
  /** Rejected-op banner / chip action → the Sync Status screen (§3.6/§8.4). */
  readonly onOpenSyncStatus: () => void;
  readonly testID?: string | undefined;
}

interface LoadedNote {
  readonly note: NoteRow | undefined;
  readonly statuses: NoteSyncStatuses;
}

export function NoteDetail({
  noteId,
  now,
  syncChip,
  avatar,
  onBack,
  onEdit,
  onOpenSyncStatus,
  testID = 'notes.detail',
}: NoteDetailProps): React.JSX.Element {
  const archiveNote = useCommand((rt) => rt.archiveNote);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  const query = useQuery<LoadedNote>(
    async (rt) => {
      const page = await rt.getNote({ noteId });
      const statuses = await rt.noteSyncStatuses([noteId]);
      return { note: page.rows[0], statuses };
    },
    `detail:${noteId}:${String(reloadNonce)}`,
  );

  const note = query.status === 'ready' ? query.data.note : undefined;
  const rejected = query.status === 'ready' && hasRejectedOp(query.data.statuses[noteId] ?? []);

  // Hooks run unconditionally; the thumbnail loads only once a note with an attachment is in hand.
  const thumbnail = useThumbnail(note?.mediaId ?? null);

  const archive = (): void => {
    setConfirmArchive(false);
    // Optimistic (§4.1): fire and return to the list, which re-renders with the note now archived
    // (filtered from the active view by default).
    void archiveNote({ noteId });
    onBack();
  };

  return (
    <AppShell
      title={tn('notes.list.title')}
      titleVariant="detail"
      onBack={onBack}
      backLabel={t('core.action.back')}
      syncChip={syncChip}
      avatar={avatar}
      banner={
        rejected ? (
          <Banner
            variant="danger"
            message={t('sync.rejected.banner', { count: 1 })}
            onPress={onOpenSyncStatus}
            testID={`${testID}.rejectedBanner`}
          />
        ) : undefined
      }
      testID={testID}
    >
      {renderBody()}

      {confirmArchive && note !== undefined ? (
        <ConfirmSheet
          title={tn('notes.action.archive')}
          message={tn('notes.confirm.archive')}
          confirmLabel={tn('notes.action.archive')}
          onConfirm={archive}
          cancelLabel={t('core.action.cancel')}
          onCancel={() => setConfirmArchive(false)}
          testID={`${testID}.archiveConfirm`}
        />
      ) : null}
    </AppShell>
  );

  function renderBody(): React.JSX.Element {
    switch (query.status) {
      case 'loading':
        // The loading STATE is the wrapper (present at once); LoadingState delays its own content
        // 300 ms to avoid a flash (§3.9), so the testID lives on the container, as `List` does.
        return (
          <View testID={`${testID}.loading`}>
            <LoadingState variant="spinner" />
          </View>
        );
      case 'unauthorized':
        return (
          <UnauthorizedState
            title={t('core.errors.PERMISSION_DENIED')}
            backLabel={t('core.action.back')}
            onBack={onBack}
            testID={`${testID}.unauthorized`}
          />
        );
      case 'error':
        // A note that isn't there is Empty, not Error — the thing asked for is simply not here.
        if (query.code === 'ENTITY_NOT_FOUND') {
          return (
            <EmptyState title={t('core.errors.ENTITY_NOT_FOUND')} testID={`${testID}.empty`} />
          );
        }
        return (
          <ErrorState
            title={translateErrorCode(query.code)}
            errorCode={query.code}
            retryLabel={t('core.action.retry')}
            onRetry={() => setReloadNonce((current) => current + 1)}
            testID={`${testID}.error`}
          />
        );
      case 'ready':
        if (note === undefined) {
          return (
            <EmptyState title={t('core.errors.ENTITY_NOT_FOUND')} testID={`${testID}.empty`} />
          );
        }
        return renderNote(note);
    }
  }

  function renderNote(row: NoteRow): React.JSX.Element {
    return (
      <View testID={`${testID}.content`}>
        <Card testID={`${testID}.card`}>
          <Text style={styles.title} testID={`${testID}.heading`}>
            {row.title}
          </Text>
          {row.archived ? (
            <Text style={styles.archived} testID={`${testID}.archivedBadge`}>
              {tn('notes.badge.archived')}
            </Text>
          ) : null}
          {row.body === '' ? null : (
            <Text style={styles.body} testID={`${testID}.body`}>
              {row.body}
            </Text>
          )}
          {row.mediaId === null ? null : (
            <View style={styles.thumbWrap} testID={`${testID}.thumb`}>
              {renderThumbnail()}
            </View>
          )}
          <Text style={styles.meta} testID={`${testID}.meta`}>
            {formatRelative(now - row.lastEditedAt)}
          </Text>
        </Card>

        {row.archived ? null : (
          <View style={styles.actions}>
            <Button
              label={t('core.action.edit')}
              variant="secondary"
              onPress={() => onEdit(row.id)}
              testID={`${testID}.edit`}
            />
            {/* Destructive, separated from the secondary above by §3.1 spacing. */}
            <View style={styles.archiveGap}>
              <Button
                label={tn('notes.action.archive')}
                variant="destructive"
                onPress={() => setConfirmArchive(true)}
                testID={`${testID}.archive`}
              />
            </View>
          </View>
        )}
      </View>
    );
  }

  function renderThumbnail(): React.JSX.Element {
    switch (thumbnail.kind) {
      case 'loading':
        return <LoadingState variant="spinner" testID={`${testID}.thumb.loading`} />;
      case 'ready':
        return (
          <Image
            source={{ uri: thumbnail.uri }}
            contentFit="cover"
            style={styles.thumb}
            testID={`${testID}.thumb.image`}
          />
        );
      case 'unavailable':
        // api/03 §8: transient — the op may precede the media. Neutral, not an error state.
        return (
          <View style={styles.thumbPlaceholder}>
            <Icon name="pending" size={size.iconState} color={color.textMuted} />
            <Text style={styles.thumbNote} testID={`${testID}.thumb.unavailable`}>
              {t('core.errors.MEDIA_NOT_FOUND')}
            </Text>
          </View>
        );
      case 'mismatch':
        // 06 §6: two fetches disagreed with the signed hash — NEVER show the bytes.
        return (
          <View style={styles.thumbPlaceholder}>
            <Icon name="rejected" size={size.iconState} color={color.danger} />
            <Text style={styles.thumbDanger} testID={`${testID}.thumb.mismatch`}>
              {t('core.errors.HASH_MISMATCH')}
            </Text>
          </View>
        );
    }
  }
}

const styles = StyleSheet.create({
  title: { ...type.heading, color: color.text },
  archived: { ...type.caption, color: color.textMuted, marginTop: space.xs },
  body: { ...type.body, color: color.text, marginTop: space.md },
  meta: { ...type.caption, color: color.textMuted, marginTop: space.lg },
  thumbWrap: { marginTop: space.md },
  // Full-width, natural 16:9 preview — expo-image downsamples to the layout size (design-system §7),
  // so a ratio rather than a fixed pixel height keeps the closed size scale intact (no invented dp).
  thumb: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: radius.md,
    backgroundColor: color.surfaceAlt,
  },
  thumbPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.xl,
    backgroundColor: color.surfaceAlt,
    borderRadius: radius.md,
  },
  thumbNote: { ...type.bodySm, color: color.textMuted, marginTop: space.sm, textAlign: 'center' },
  thumbDanger: { ...type.bodySm, color: color.danger, marginTop: space.sm, textAlign: 'center' },
  actions: { marginTop: space.lg },
  archiveGap: { marginTop: space.xl },
});
