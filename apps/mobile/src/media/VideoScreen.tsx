// The video recorder and player screen (the ownership video). The viewfinder or the player takes the
// content area, as on the photo camera, with one action at the bottom: start, stop, or use the clip.
// While recording, the time taken and the time allowed show over the viewfinder.
import { t, translateErrorCode } from '@bolusi/i18n';
import {
  AppShell,
  Banner,
  Button,
  ErrorState,
  LoadingState,
  UnauthorizedState,
  color,
  radius,
  space,
  type,
  Text,
} from '@bolusi/ui';
import type { StorageBand } from '@bolusi/core';
import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { storageBanner } from './CaptureScreen.js';

export type VideoScreenState =
  | { readonly kind: 'permission_pending' }
  | { readonly kind: 'permission_denied' }
  | { readonly kind: 'warming_up' }
  | { readonly kind: 'ready'; readonly band: StorageBand }
  | { readonly kind: 'recording'; readonly startedAt: number }
  | { readonly kind: 'saving' }
  | { readonly kind: 'review'; readonly uri: string }
  | { readonly kind: 'refused_low_storage' }
  /** Bigger than the server takes: the camera ignored the bitrate asked for. */
  | { readonly kind: 'too_large' }
  | { readonly kind: 'failed'; readonly code: string }
  // Watching a stored clip.
  | { readonly kind: 'loading' }
  | { readonly kind: 'playing'; readonly uri: string }
  | { readonly kind: 'unavailable' };

export interface VideoScreenProps {
  readonly title: string;
  readonly hint: string;
  readonly state: VideoScreenState;
  readonly view: ReactNode;
  readonly maxMs: number;
  readonly syncChip: ReactNode;
  readonly avatar: ReactNode;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onRetake: () => void;
  readonly onUse: () => void;
  readonly onRetry: () => void;
  readonly onBack: () => void;
  /** The clock for the recording timer; tests pass their own. */
  readonly now?: () => number;
}

/** "0:07" for 7 s: minutes and seconds, as a phone's own recorder shows them. */
export function clipTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

export function VideoScreen({
  title,
  hint,
  state,
  view,
  maxMs,
  syncChip,
  avatar,
  onStart,
  onStop,
  onRetake,
  onUse,
  onRetry,
  onBack,
  now = Date.now,
}: VideoScreenProps): React.JSX.Element {
  const banner = state.kind === 'ready' ? storageBanner(state.band) : null;
  return (
    <AppShell
      title={title}
      titleVariant="detail"
      onBack={onBack}
      backLabel={t('core.action.back')}
      syncChip={syncChip}
      avatar={avatar}
      banner={
        banner === null ? undefined : (
          <Banner variant={banner.variant} message={banner.message} testID="video-storage-banner" />
        )
      }
      bottomAction={bottomAction(state, { onStart, onStop, onRetake, onUse })}
      testID="video-screen"
    >
      {content()}
    </AppShell>
  );

  function content(): ReactNode {
    switch (state.kind) {
      case 'permission_pending':
      case 'loading':
      case 'saving':
        return <LoadingState variant="spinner" testID="video-loading" />;
      case 'permission_denied':
        return (
          <UnauthorizedState
            title={t('media.permission.videoDeniedTitle')}
            hint={t('media.permission.videoDeniedBody')}
            backLabel={t('core.action.back')}
            onBack={onBack}
            testID="video-unauthorized"
          />
        );
      case 'refused_low_storage':
        return (
          <ErrorState
            title={t('media.capture.refusedTitle')}
            hint={t('media.video.refusedBody')}
            retryLabel={t('core.action.retry')}
            onRetry={onRetry}
            testID="video-refused"
          />
        );
      case 'too_large':
        return (
          <ErrorState
            title={t('media.video.tooLarge')}
            retryLabel={t('media.video.retake')}
            onRetry={onRetry}
            testID="video-too-large"
          />
        );
      case 'failed':
        return (
          <ErrorState
            title={translateErrorCode(state.code)}
            errorCode={state.code}
            retryLabel={t('core.action.retry')}
            onRetry={onRetry}
            testID="video-failed"
          />
        );
      case 'unavailable':
        return (
          <ErrorState
            title={t('media.video.unavailableTitle')}
            hint={t('media.video.unavailableBody')}
            retryLabel={t('core.action.retry')}
            onRetry={onRetry}
            testID="video-unavailable"
          />
        );
      case 'warming_up':
      case 'ready':
      case 'recording':
        return (
          <View style={styles.frameColumn}>
            {hint === '' ? null : (
              <Text style={styles.hint} testID="video-hint">
                {hint}
              </Text>
            )}
            <View style={styles.frame} testID="video-viewfinder">
              {view}
              {state.kind === 'warming_up' ? (
                <View style={styles.cover}>
                  <LoadingState variant="spinner" testID="video-loading" />
                </View>
              ) : null}
              {state.kind === 'recording' ? (
                <RecordingTime startedAt={state.startedAt} maxMs={maxMs} now={now} />
              ) : null}
            </View>
          </View>
        );
      case 'review':
      case 'playing':
        return (
          <View style={styles.frame} testID={`video-${state.kind}`}>
            {view}
          </View>
        );
    }
  }
}

function RecordingTime({
  startedAt,
  maxMs,
  now,
}: {
  readonly startedAt: number;
  readonly maxMs: number;
  readonly now: () => number;
}): React.JSX.Element {
  const [elapsed, setElapsed] = useState(() => now() - startedAt);
  useEffect(() => {
    const timer = setInterval(() => setElapsed(now() - startedAt), 250);
    return () => clearInterval(timer);
  }, [startedAt, now]);
  return (
    <View style={styles.timer} testID="video-timer">
      <View style={styles.dot} />
      <Text style={styles.timerText}>
        {t('media.video.time', {
          elapsed: clipTime(Math.min(elapsed, maxMs)),
          max: clipTime(maxMs),
        })}
      </Text>
    </View>
  );
}

function bottomAction(
  state: VideoScreenState,
  handlers: {
    readonly onStart: () => void;
    readonly onStop: () => void;
    readonly onRetake: () => void;
    readonly onUse: () => void;
  },
): ReactNode {
  switch (state.kind) {
    case 'ready':
      return (
        <Button label={t('media.video.start')} onPress={handlers.onStart} testID="video-start" />
      );
    case 'recording':
      return (
        <Button
          label={t('media.video.stop')}
          variant="destructive"
          onPress={handlers.onStop}
          testID="video-stop"
        />
      );
    case 'saving':
      return <Button label={t('media.video.stop')} busy onPress={() => undefined} />;
    case 'review':
      return (
        <View style={styles.reviewActions}>
          <Button
            label={t('media.video.retake')}
            variant="secondary"
            onPress={handlers.onRetake}
            testID="video-retake"
          />
          <Button label={t('media.video.use')} onPress={handlers.onUse} testID="video-use" />
        </View>
      );
    case 'playing':
      return (
        <Button
          label={t('core.action.close')}
          variant="secondary"
          onPress={handlers.onUse}
          testID="video-done"
        />
      );
    default:
      return null;
  }
}

const styles = StyleSheet.create({
  frameColumn: { flex: 1, gap: space.sm },
  hint: { ...type.body, color: color.text },
  frame: {
    flex: 1,
    backgroundColor: color.surfaceAlt,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  cover: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: color.surfaceAlt,
  },
  timer: {
    position: 'absolute',
    top: space.sm,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.md,
    backgroundColor: color.overlay,
  },
  dot: {
    width: space.sm,
    height: space.sm,
    borderRadius: radius.full,
    backgroundColor: color.danger,
  },
  timerText: { ...type.bodySm, color: color.onPrimary, fontVariant: ['tabular-nums'] },
  reviewActions: { gap: space.sm },
});
