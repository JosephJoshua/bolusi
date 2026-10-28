// The ownership video the same on the phone and the PC: recording and playing it through the
// platform, and a servisan's clip as its screens show it (the latest one taken, whether one is
// still needed, and taking one after intake). The views around it are each platform's own.
import { useEffect, useRef } from 'react';

import type { ActionRunner, CapturedVideo, VideoMediaRef } from '../screen-kit/index.js';
import { OWNERSHIP_VIDEO_MAX_MS } from './constants.js';
import { ownershipVideoOf, videoRefOf, type IntakeDraft } from './flows.js';
import { tn } from './i18n.js';
import { needsOwnershipVideo } from './intake-options.js';
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
  /** Whether the servisan shows the video at all: one was taken, or a repair type asks for it. */
  readonly shown: boolean;
  /** The latest clip, or null when none was taken. */
  readonly latest: TicketPhotoRow | null;
  readonly video: VideoMediaRef | null;
  /** Absent when this person or device cannot take one here. */
  readonly record: (() => void) | undefined;
  /** This person may take one, but this device has no camera for it. */
  readonly noCamera: boolean;
  readonly play: ((video: VideoMediaRef) => void) | undefined;
}

/**
 * A servisan's ownership video. While the phone is still in the store the counter can take it, or
 * retake it, through `recordOwnershipVideo`; until then a repaired phone cannot be handed over.
 */
export function useTicketVideo({
  ticket,
  canRecord,
  runner,
  onRecorded,
}: {
  readonly ticket: TicketDetailRow;
  /** Intake permission and a servisan still open. */
  readonly canRecord: boolean;
  readonly runner: ActionRunner;
  readonly onRecorded: () => void;
}): TicketVideo {
  const runtime = useRepairRuntime();
  const { record, play } = useOwnershipVideo();
  const latest = ownershipVideoOf(ticket);
  return {
    shown: latest !== null || needsOwnershipVideo(ticket.repairTypes),
    latest,
    video: latest === null ? null : videoRefOf(latest),
    record:
      canRecord && record !== undefined
        ? (): void => {
            void runner
              .run(async () => {
                const captured = await record();
                if (captured === null) return null;
                await runtime.run('recordOwnershipVideo', {
                  ticketId: ticket.id,
                  video: captured.videoRef,
                });
                return captured;
              })
              .then((captured) => {
                if (captured !== undefined && captured !== null) onRecorded();
              });
          }
        : undefined,
    noCamera: canRecord && record === undefined,
    play: play === undefined ? undefined : (ref) => void runner.run(() => play(ref)),
  };
}
