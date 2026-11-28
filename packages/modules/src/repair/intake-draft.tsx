// An intake's draft, the same on the phone and the PC. It carries the servisan's id from the
// start, so a draft kept across a crash between opening the servisan and clearing the draft opens
// nothing twice: the servisan is shown instead. Photos and the ownership video a kept draft
// refers to that no longer load are dropped, so they are taken again.
import { useEffect, useRef, useState } from 'react';

import type { PaymentAccountRow } from '../money/queries.js';
import type { ActionRunner } from '../screen-kit/index.js';

import {
  capturedThumbnailRef,
  emptyIntakeDraft,
  toOpenTicketInput,
  type IntakeDraft,
} from './flows.js';
import type { IntakeOptionLists } from './intake-options.js';
import { useRestoredVideoCheck } from './ownership-video.js';
import { useRepairRuntime } from './runtime.js';

/** `onOpenedAlready` gets the id of a kept draft's servisan that was opened before the app died. */
export function useIntakeDraft(
  restoredDraft: IntakeDraft | null | undefined,
  onOpenedAlready: (ticketId: string) => void,
) {
  const runtime = useRepairRuntime();
  const [draft, setDraft] = useState<IntakeDraft>(() => {
    const start = restoredDraft ?? emptyIntakeDraft();
    return start.ticketId === undefined ? { ...start, ticketId: runtime.newId() } : start;
  });
  const [restoredOnce] = useState(restoredDraft ?? null);
  const [photosExpired, setPhotosExpired] = useState(false);
  const [videoExpired, setVideoExpired] = useState(false);
  useRestoredVideoCheck(restoredOnce, () => {
    setDraft((d) => ({ ...d, ownershipVideo: null }));
    setVideoExpired(true);
  });

  useEffect(() => {
    if (restoredOnce === null) return;
    let live = true;
    const checks = Object.values(restoredOnce.photos).map(async (ref) => {
      if (ref === undefined) return null;
      const state = await runtime
        .loadThumbnail(capturedThumbnailRef(ref))
        .catch(() => ({ kind: 'unavailable' }) as const);
      return state.kind === 'ready' ? null : ref.mediaId;
    });
    void Promise.all(checks).then((results) => {
      const gone = new Set(results.filter((id): id is string => id !== null));
      if (!live || gone.size === 0) return;
      setDraft((d) => ({
        ...d,
        photos: Object.fromEntries(
          Object.entries(d.photos).filter(([, ref]) => ref === undefined || !gone.has(ref.mediaId)),
        ),
      }));
      setPhotosExpired(true);
    });
    return () => {
      live = false;
    };
  }, [restoredOnce, runtime]);

  const opened = useRef(onOpenedAlready);
  opened.current = onOpenedAlready;
  useEffect(() => {
    const ticketId = restoredOnce?.ticketId;
    if (ticketId === undefined) return;
    let live = true;
    // Read in a promise, so a runtime that throws on a missing servisan reads as "not opened".
    void Promise.resolve()
      .then(() => runtime.query('getTicket', { ticketId }))
      .then(
        (found) => {
          if (live && found.rows.length > 0) opened.current(ticketId);
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [restoredOnce, runtime]);

  return { draft, setDraft, photosExpired, videoExpired };
}

/**
 * Opens the servisan the draft describes, dated when it is saved (`now`), under the step's own
 * runner so the save shows busy and refused where the step shows it.
 */
export function useOpenTicket(
  runner: ActionRunner,
  now: () => number,
  onOpened: (ticketId: string) => void,
) {
  const runtime = useRepairRuntime();
  return (
    draft: IntakeDraft,
    options: IntakeOptionLists,
    accounts: readonly PaymentAccountRow[],
  ): void => {
    void runner
      .run(() => runtime.run('openTicket', toOpenTicketInput(draft, options, now(), accounts)))
      .then((opened) => {
        if (opened !== undefined) onOpened(opened.ticketId);
      });
  };
}
