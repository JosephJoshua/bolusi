// Putting right what intake wrote down, the same on the phone and the PC: intake's own fields, of
// which only what differs is saved, with a reason, and the servisan's history keeps what it was.
// Each app only draws the fields.
import { useState } from 'react';

import { useActionRunner } from '../screen-kit/index.js';

import {
  INTAKE_PROBLEM_KEY,
  correctionDraft,
  correctionOptions,
  correctionProblems,
  toCorrectionInput,
  type IntakeDraft,
  type IntakeProblem,
} from './flows.js';
import { tn } from './i18n.js';
import { storeIntakeOptions } from './intake-options.js';
import type { TicketDetailRow } from './queries.js';
import { useIntakeOptionSettings, useRepairRuntime } from './runtime.js';

/**
 * Saving with nothing changed only closes the step (`onUnchanged`); with something to fix, the
 * problems show and `onProblems` runs (the PC takes the counter to the first one).
 */
export function useCorrectDetails(
  ticket: TicketDetailRow,
  done: {
    readonly onDone: () => void;
    readonly onUnchanged: () => void;
    readonly onProblems?: (() => void) | undefined;
  },
) {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const settings = useIntakeOptionSettings();
  const [initial] = useState(() => correctionDraft(ticket));
  const [draft, setDraft] = useState(initial);
  const [reason, setReason] = useState('');
  const [showProblems, setShowProblems] = useState(false);
  const update = (patch: Partial<IntakeDraft>): void => setDraft((d) => ({ ...d, ...patch }));
  const options =
    settings.status === 'ready'
      ? correctionOptions(storeIntakeOptions(settings.data), ticket)
      : null;
  const problems = options === null ? [] : correctionProblems(draft, options);
  const changed = JSON.stringify(draft) !== JSON.stringify(initial);
  const submit = (): void => {
    if (options === null) return;
    if (problems.length > 0) {
      setShowProblems(true);
      done.onProblems?.();
      return;
    }
    if (!changed) {
      done.onUnchanged();
      return;
    }
    void runner
      .run(() =>
        runtime.run('correctTicketDetails', toCorrectionInput(ticket, draft, options, reason)),
      )
      .then((result) => {
        if (result !== undefined) done.onDone();
      });
  };
  return {
    runner,
    settings,
    draft,
    setDraft,
    update,
    reason,
    setReason,
    options,
    /** What a field shows under it, once saving was tried with something to fix. */
    problemText: (problem: IntakeProblem): string | undefined =>
      showProblems && problems.includes(problem) ? tn(INTAKE_PROBLEM_KEY[problem]) : undefined,
    changed,
    dirty: changed || reason.trim() !== '',
    submit,
  };
}
