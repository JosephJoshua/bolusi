// The in-app video recorder and player (the ownership video, docs/product-scope.md). Like
// `CaptureHost` it holds the deferred a screen awaits and hands the shell a surface to render: the
// recorder while a clip is taken, or the player while a stored one is watched. The native camera and
// player arrive as a `VideoPlatform`, so everything here runs under Node.
import { errorCodeOrUnexpected, type StorageBand } from '@bolusi/core';
import type {
  CaptureRequest,
  CapturedVideo,
  VideoCapture,
  VideoMediaRef,
  VideoPlayback,
} from '@bolusi/modules/screen-kit';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';

import type { CaptureIdentity } from '@bolusi/device/media/capture';
import type { MediaClient } from '@bolusi/device/media/client';
import type { RecordedVideo } from '@bolusi/device/media/import';
import { usePendingCapture } from './pending-capture.js';
import type { VideoScreenState } from './VideoScreen.js';

/** A camera ready to record: `record` resolves with the clip once it stops or `maxMs` is up. */
export interface VideoRecorderPort {
  record(maxMs: number): Promise<RecordedVideo>;
  stop(): void;
}

/** The native seams, bound where `expo-camera` and `expo-video` are imported. */
export interface VideoPlatform {
  /** Camera and microphone, both: a clip of the customer speaking needs the sound. */
  ensurePermission(): Promise<boolean>;
  /** The live viewfinder; `publish` gets the recorder once the camera is ready, null when gone. */
  renderPreview(publish: (recorder: VideoRecorderPort | null) => void): ReactNode;
  /** A player for a decrypted clip, with its own controls. */
  renderPlayer(uri: string): ReactNode;
  /** Deletes a recorded clip nobody kept (backed out while it saved): it is unencrypted. */
  discard(uri: string): void;
}

/** What the shell renders while a clip is recorded or watched. `null` ⇒ neither. */
export interface VideoSurface {
  readonly title: string;
  /** What the clip must show; empty while playing one back. */
  readonly hint: string;
  readonly state: VideoScreenState;
  /** The viewfinder while recording, the player in review and playback. */
  readonly view: ReactNode;
  readonly maxMs: number;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onRetake: () => void;
  readonly onUse: () => void;
  readonly onRetry: () => void;
  readonly onBack: () => void;
}

export interface VideoHost {
  readonly recordVideo: VideoCapture;
  readonly playVideo: VideoPlayback;
  readonly surface: VideoSurface | null;
}

export interface VideoHostDeps {
  readonly media: MediaClient | null;
  readonly platform: VideoPlatform | null;
  readonly identity: CaptureIdentity | null;
}

export function useVideoHost(deps: VideoHostDeps): VideoHost {
  const [state, setState] = useState<VideoScreenState | null>(null);
  const [title, setTitle] = useState('');
  const [hint, setHint] = useState('');
  const [maxMs, setMaxMs] = useState(0);
  const [review, setReview] = useState<{ uri: string; video: CapturedVideo } | null>(null);
  const [playing, setPlayingState] = useState<{ ref: VideoMediaRef; done: () => void } | null>(
    null,
  );
  // Read through a ref by the callbacks, so they stay the same functions for the runtime they are
  // bound into (a new one would rebuild the session's screens).
  const playingRef = useRef(playing);
  const setPlaying = useCallback((next: typeof playing): void => {
    playingRef.current = next;
    setPlayingState(next);
  }, []);
  const recorderRef = useRef<VideoRecorderPort | null>(null);
  const mediaRef = useRef<MediaClient | null>(deps.media);
  mediaRef.current = deps.media;

  const pending = usePendingCapture<CapturedVideo>(deps.identity, () => {
    setState(null);
    setReview(null);
  });
  const { open, settle, isOpen, identity: actingIdentity, stranded } = pending;

  const enterReady = useCallback(async (): Promise<void> => {
    const platform = deps.platform;
    if (platform === null) return;
    setState({ kind: 'permission_pending' });
    const granted = await platform.ensurePermission();
    if (!isOpen()) return;
    if (!granted) {
      setState({ kind: 'permission_denied' });
      return;
    }
    const band: StorageBand = mediaRef.current?.storageBand() ?? 'normal';
    if (band === 'capture_refused') {
      setState({ kind: 'refused_low_storage' });
      return;
    }
    setState(recorderRef.current === null ? { kind: 'warming_up' } : { kind: 'ready', band });
  }, [deps.platform, isOpen]);

  const recordVideo = useCallback<VideoCapture>(
    (request) => {
      if (deps.media === null || deps.platform === null || actingIdentity() === null) {
        return Promise.reject(new Error('video recording is not available on this device'));
      }
      if (isOpen() || playingRef.current !== null) {
        return Promise.reject(new Error('the camera is busy'));
      }
      const opened = open();
      setTitle(request.title);
      setHint(request.hint);
      setMaxMs(request.maxMs);
      void enterReady();
      return opened;
    },
    [deps.media, deps.platform, actingIdentity, isOpen, open, enterReady],
  );

  /** Resolve a stored or just-recorded clip to a playable uri, checked against its signed hash. */
  const load = useCallback(async (ref: VideoMediaRef): Promise<VideoScreenState> => {
    const media = mediaRef.current;
    if (media === null) return { kind: 'unavailable' };
    try {
      const rendered = await media.loadForRender(ref);
      if (rendered.kind === 'local' || rendered.kind === 'cached') {
        return { kind: 'playing', uri: rendered.uri };
      }
      return rendered.kind === 'unavailable'
        ? { kind: 'unavailable' }
        : { kind: 'failed', code: 'HASH_MISMATCH' };
    } catch (error: unknown) {
      return { kind: 'failed', code: errorCodeOrUnexpected(error) };
    }
  }, []);

  const playVideo = useCallback<VideoPlayback>(
    (ref: VideoMediaRef, request: CaptureRequest) => {
      if (deps.platform === null) return Promise.reject(new Error('no video player'));
      if (isOpen() || playingRef.current !== null) {
        return Promise.reject(new Error('the player is busy'));
      }
      return new Promise<void>((resolve) => {
        setTitle(request.title);
        setPlaying({ ref, done: resolve });
        setState({ kind: 'loading' });
        void load(ref).then(setState);
      });
    },
    [deps.platform, isOpen, setPlaying, load],
  );

  const publishRecorder = useCallback((recorder: VideoRecorderPort | null): void => {
    recorderRef.current = recorder;
    setState((current) => {
      if (current === null) return current;
      if (recorder === null && current.kind === 'ready') return { kind: 'warming_up' };
      if (recorder !== null && current.kind === 'warming_up') {
        return { kind: 'ready', band: mediaRef.current?.storageBand() ?? 'normal' };
      }
      return current;
    });
  }, []);

  const onStart = useCallback((): void => {
    const media = mediaRef.current;
    const identity = actingIdentity();
    const recorder = recorderRef.current;
    if (media === null || identity === null || recorder === null) return;
    setState({ kind: 'recording', startedAt: Date.now() });
    void recorder
      .record(maxMs)
      .then(async (recorded) => {
        if (!isOpen()) {
          deps.platform?.discard(recorded.uri);
          return;
        }
        setState({ kind: 'saving' });
        const outcome = await media.importVideo(identity, recorded);
        if (!isOpen()) return;
        if (outcome.kind === 'refused_low_storage') {
          setState({ kind: 'refused_low_storage' });
          return;
        }
        if (outcome.kind === 'refused_too_large') {
          setState({ kind: 'too_large' });
          return;
        }
        const shown = await load(outcome.ref);
        if (!isOpen()) return;
        if (shown.kind !== 'playing') {
          setState({ kind: 'failed', code: 'STORAGE_ERROR' });
          return;
        }
        setReview({ uri: shown.uri, video: { videoRef: outcome.ref } });
        setState({ kind: 'review', uri: shown.uri });
      })
      .catch((error: unknown) => {
        if (isOpen()) setState({ kind: 'failed', code: errorCodeOrUnexpected(error) });
      });
  }, [actingIdentity, isOpen, load, maxMs, deps.platform]);

  const surface = useMemo<VideoSurface | null>(() => {
    if (state === null || deps.platform === null) return null;
    const platform = deps.platform;
    if (playing !== null) {
      const close = (): void => {
        setPlaying(null);
        setState(null);
        playing.done();
      };
      return {
        title,
        hint: '',
        state,
        view: state.kind === 'playing' ? platform.renderPlayer(state.uri) : null,
        maxMs: 0,
        onStart: () => undefined,
        onStop: () => undefined,
        onRetake: () => undefined,
        onUse: close,
        onRetry: () => {
          setState({ kind: 'loading' });
          void load(playing.ref).then(setState);
        },
        onBack: close,
      };
    }
    if (stranded) return null;
    return {
      title,
      hint,
      state,
      view:
        state.kind === 'review'
          ? platform.renderPlayer(state.uri)
          : platform.renderPreview(publishRecorder),
      maxMs,
      onStart,
      onStop: () => recorderRef.current?.stop(),
      onRetake: () => {
        // The discarded clip's row and file go with the 24 h orphan rule, like a retaken photo.
        setReview(null);
        void enterReady();
      },
      onUse: () => settle(review?.video ?? null),
      onRetry: () => void enterReady(),
      onBack: () => {
        recorderRef.current?.stop();
        settle(null);
      },
    };
  }, [
    state,
    deps.platform,
    playing,
    stranded,
    title,
    hint,
    maxMs,
    publishRecorder,
    onStart,
    enterReady,
    settle,
    review,
    load,
    setPlaying,
  ]);

  return { recordVideo, playVideo, surface };
}
