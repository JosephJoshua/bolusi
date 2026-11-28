// The technician's and the counter's small ticket steps, the same on the phone and the PC: before
// photos to start work, after photos (and a note) to mark it repaired, waiting for parts, and an
// owner taking back a handover recorded by mistake. Each app only draws the form.
import type { MediaRef } from '@bolusi/schemas';
import { useState } from 'react';

import { useActionRunner } from '../screen-kit/index.js';

import type { WorkPhotoStage } from './constants.js';
import type { RepairKey } from './i18n.js';
import { useRepairRuntime } from './runtime.js';

/** What each work-photo step is called and asks for. */
export const WORK_STAGE_COPY: Readonly<
  Record<WorkPhotoStage, { title: RepairKey; hint: RepairKey; shot: RepairKey; submit: RepairKey }>
> = {
  before: {
    title: 'repair.work.beforeTitle',
    hint: 'repair.work.beforeHint',
    shot: 'repair.work.beforeShot',
    submit: 'repair.action.start',
  },
  after: {
    title: 'repair.work.afterTitle',
    hint: 'repair.work.afterHint',
    shot: 'repair.work.afterShot',
    submit: 'repair.action.markRepaired',
  },
};

/** At least one photo is required either way (owner decision, 2026-10-25). */
export function useWorkPhotos(ticketId: string, stage: WorkPhotoStage, onDone: () => void) {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [photos, setPhotos] = useState<readonly MediaRef[]>([]);
  const [note, setNote] = useState('');
  const submit = (): void => {
    void runner
      .run(() =>
        stage === 'before'
          ? runtime.run('startWork', { ticketId, beforePhotos: [...photos] })
          : runtime.run('markRepaired', { ticketId, afterPhotos: [...photos], note }),
      )
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };
  return {
    runner,
    photos,
    setPhotos,
    note,
    setNote,
    copy: WORK_STAGE_COPY[stage],
    dirty: photos.length > 0 || note.trim() !== '',
    submit,
  };
}

/** Parked waiting for parts, with what is awaited. */
export function useWaitForParts(ticketId: string, onDone: () => void) {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [note, setNote] = useState('');
  const submit = (): void => {
    void runner
      .run(() => runtime.run('markWaitingForParts', { ticketId, note }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };
  return { runner, note, setNote, submit };
}

/** The phone is in the store again. A reason is required. */
export function useUndoHandover(ticketId: string, onDone: () => void) {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [reason, setReason] = useState('');
  const complete = reason.trim() !== '';
  const submit = (): void => {
    if (!complete) return;
    void runner
      .run(() => runtime.run('undoHandover', { ticketId, reason }))
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };
  return { runner, reason, setReason, complete, submit };
}
