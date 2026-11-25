// The ownership video the same on the phone and the PC: recording it at intake and playing it
// through the platform, and a servisan's clip as its screens show it. It is taken only at intake;
// the handover's proof is its photo. The views around it are each platform's own.
import { useEffect, useRef } from 'react';

import type { ActionRunner, CapturedVideo, VideoMediaRef } from '../screen-kit/index.js';
import { OWNERSHIP_VIDEO_MAX_MS } from './constants.js';
import { ownershipVideoOf, videoRefOf, type IntakeDraft } from './flows.js';
import { tn } from './i18n.js';
import type { TicketDetailRow, TicketPhotoRow } from './queries.js';
import { useRepairRuntime } from './runtime.js';

/** Record and play the ownership video through the platform; absent where it cannot. */
export function useOwnershipVideo(): {
  readonly record: (() => Promise<CapturedVideo | null>) | undefined;
  readonly play: ((video: VideoMediaRef) => Promise<void>) | undefined;
} {
  const { recordVideo, playVideo } = useRepairRuntime();
  return {
    record:
      recordVideo === undefined
        ? undefined
        : () =>
            recordVideo({
              title: tn('repair.video.title'),
              hint: tn('repair.video.hint'),
              maxMs: OWNERSHIP_VIDEO_MAX_MS,
            }),
    play:
      playVideo === undefined
        ? undefined
        : (video) => playVideo(video, { title: tn('repair.video.title') }),
  };
}

/**
 * A draft kept across a lock can outlive its clip, like its photos: a capture no saved servisan
 * refers to is deleted a day after it was taken. `onGone` drops it so the counter records it again
 * instead of opening a servisan whose video never uploads.
 */
export function useRestoredVideoCheck(
  restored: Pick<IntakeDraft, 'ownershipVideo'> | null,
  onGone: () => void,
): void {
  const { videoKept } = useRepairRuntime();
  const video = restored?.ownershipVideo ?? null;
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    if (video === null || videoKept === undefined) return;
    let live = true;
    void videoKept(video)
      .catch(() => false)
      .then((kept) => {
        if (live && !kept) gone.current();
      });
    return () => {
      live = false;
    };
  }, [video, videoKept]);
}

export interface TicketVideo {
  /** The latest clip, or null when the intake took none. */
  readonly latest: TicketPhotoRow | null;
  readonly video: VideoMediaRef | null;
  readonly play: ((video: VideoMediaRef) => void) | undefined;
}

/** A servisan's ownership video, taken only at intake: shown here to be played back. */
export function useTicketVideo({
  ticket,
  runner,
}: {
  readonly ticket: TicketDetailRow;
  readonly runner: ActionRunner;
}): TicketVideo {
  const { play } = useOwnershipVideo();
  const latest = ownershipVideoOf(ticket);
  return {
    latest,
    video: latest === null ? null : videoRefOf(latest),
    play: play === undefined ? undefined : (ref) => void runner.run(() => play(ref)),
  };
}
