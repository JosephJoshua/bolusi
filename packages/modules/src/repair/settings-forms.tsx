// The owner's small repair settings forms (cancellation fees, when an uncollected phone is flagged,
// what the slips print), shared by the phone screens and the PC's Settings pages: what was typed,
// whether it differs from what is saved, following a save from another device, and the save
// itself. The screens only draw the fields.
import { useEffect, useRef, useState } from 'react';

import { type ActionRunner, useActionRunner, useDoneNote } from '../screen-kit/index.js';
import { parseUncollectedDays } from './constants.js';
import { rebaseForm } from './form-rebase.js';
import { tn } from './i18n.js';
import {
  printSettingsForm,
  printSettingsInput,
  samePrintSettingsField,
  samePrintSettingsForm,
  type PrintSettingsForm,
} from './print-settings-form.js';
import type { CancelFees, PrintSettings } from './queries.js';
import { useRepairRuntime } from './runtime.js';

/**
 * Runs `onChange` when the live read brings new saved settings (another device's save, or this
 * form's own coming back), so an open form follows them: see `rebaseForm`.
 */
export function useFollowSaved<T>(saved: T, onChange: (next: T) => void): void {
  const seen = useRef(saved);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    if (seen.current === saved) return;
    seen.current = saved;
    latest.current(saved);
  }, [saved]);
}

/** What every settings form gives its screen besides its own fields. */
interface SettingsFormBase {
  readonly runner: ActionRunner;
  readonly dirty: boolean;
  /** What the last save did, until the next edit. */
  readonly notice: string | null;
  readonly clearNotice: () => void;
  /** Back to what is saved. */
  readonly discard: () => void;
  /** Saves the changes; with nothing changed it runs `onUnchanged` instead (the phone closes). */
  readonly save: (onUnchanged?: () => void) => void;
}

export type CancelFeesFields = { readonly [K in keyof CancelFees]: number | null };

export interface CancelFeesFormState extends SettingsFormBase {
  readonly fees: CancelFeesFields;
  readonly setFee: (key: keyof CancelFees, value: number | null) => void;
  /** Both fees are filled in. */
  readonly complete: boolean;
  /** A save was tried with a fee left empty. */
  readonly attempted: boolean;
}

export function useCancelFeesForm(saved: CancelFees): CancelFeesFormState {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [baseline, setBaseline] = useState<CancelFees>(saved);
  const [fees, setFees] = useState<CancelFeesFields>(saved);
  const [attempted, setAttempted] = useState(false);
  const { note: notice, say: setNotice } = useDoneNote();
  const dirty = fees.beforeWork !== baseline.beforeWork || fees.afterWork !== baseline.afterWork;
  useFollowSaved(saved, (next) => {
    setFees((current) => rebaseForm<CancelFeesFields>(current, baseline, next));
    setBaseline(next);
  });

  const save = (onUnchanged?: () => void): void => {
    if (runner.busy) return;
    if (!dirty) {
      onUnchanged?.();
      return;
    }
    const { beforeWork, afterWork } = fees;
    if (beforeWork === null || afterWork === null) {
      setAttempted(true);
      return;
    }
    void runner
      .run(() => runtime.run('setCancelFees', { beforeWork, afterWork }))
      .then((result) => {
        if (result === undefined) return;
        setBaseline(result);
        setFees(result);
        setAttempted(false);
        setNotice(tn('repair.fees.saved'));
      });
  };

  return {
    runner,
    fees,
    setFee: (key, value) => {
      setNotice(null);
      setFees((current) => ({ ...current, [key]: value }));
    },
    complete: fees.beforeWork !== null && fees.afterWork !== null,
    attempted,
    dirty,
    notice,
    clearNotice: () => setNotice(null),
    discard: () => {
      setAttempted(false);
      setFees(baseline);
    },
    save,
  };
}

export interface UncollectedDaysFormState extends SettingsFormBase {
  /** The days as typed: digits only, at most three. */
  readonly text: string;
  readonly setText: (typed: string) => void;
  /** The typed days when they are a valid limit. */
  readonly days: number | null;
  /** A save was tried with the days not valid. */
  readonly attempted: boolean;
}

export function useUncollectedDaysForm(saved: number): UncollectedDaysFormState {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [baseline, setBaseline] = useState(saved);
  const [text, setText] = useState(String(saved));
  const [attempted, setAttempted] = useState(false);
  const { note: notice, say: setNotice } = useDoneNote();
  const days = parseUncollectedDays(text);
  const dirty = days !== baseline;
  useFollowSaved(saved, (next) => {
    if (!dirty) setText(String(next));
    setBaseline(next);
  });

  const save = (onUnchanged?: () => void): void => {
    if (runner.busy) return;
    if (!dirty) {
      onUnchanged?.();
      return;
    }
    if (days === null) {
      setAttempted(true);
      return;
    }
    void runner
      .run(() => runtime.run('setUncollectedDays', { days }))
      .then((result) => {
        if (result === undefined) return;
        setBaseline(result.days);
        setText(String(result.days));
        setAttempted(false);
        setNotice(tn('repair.uncollected.saved'));
      });
  };

  return {
    runner,
    text,
    setText: (typed) => {
      setNotice(null);
      setText(typed.replace(/\D/g, '').slice(0, 3));
    },
    days,
    attempted,
    dirty,
    notice,
    clearNotice: () => setNotice(null),
    discard: () => {
      setAttempted(false);
      setText(String(baseline));
    },
    save,
  };
}

export interface PrintSettingsFormState extends SettingsFormBase {
  readonly form: PrintSettingsForm;
  readonly edit: (patch: Partial<PrintSettingsForm>) => void;
  /** This device can pick a logo photo. */
  readonly canPickLogo: boolean;
  readonly pickLogo: () => void;
}

export function usePrintSettingsForm(saved: PrintSettings): PrintSettingsFormState {
  const runtime = useRepairRuntime();
  const runner = useActionRunner();
  const [baseline, setBaseline] = useState<PrintSettingsForm>(() => printSettingsForm(saved));
  const [form, setForm] = useState<PrintSettingsForm>(baseline);
  const { note: notice, say: setNotice } = useDoneNote();
  const dirty = !samePrintSettingsForm(form, baseline);
  useFollowSaved(saved, (next) => {
    const nextForm = printSettingsForm(next);
    setForm((current) => rebaseForm(current, baseline, nextForm, samePrintSettingsField));
    setBaseline(nextForm);
  });

  const edit = (patch: Partial<PrintSettingsForm>): void => {
    setNotice(null);
    setForm((current) => ({ ...current, ...patch }));
  };

  const pickLogo = (): void => {
    const pick = runtime.pickPhoto;
    if (pick === undefined) return;
    void runner
      .run(() => pick({ title: tn('repair.printSettings.logoTitle') }))
      .then((picked) => {
        if (picked !== undefined && picked !== null) edit({ logo: picked.mediaRef });
      });
  };

  const save = (onUnchanged?: () => void): void => {
    if (runner.busy) return;
    if (!dirty) {
      onUnchanged?.();
      return;
    }
    const sent = form;
    void runner
      .run(() => runtime.run('setPrintSettings', printSettingsInput(sent)))
      .then((result) => {
        if (result === undefined) return;
        setBaseline(sent);
        setNotice(tn('repair.printSettings.saved'));
      });
  };

  return {
    runner,
    form,
    edit,
    canPickLogo: runtime.pickPhoto !== undefined,
    pickLogo,
    dirty,
    notice,
    clearNotice: () => setNotice(null),
    discard: () => setForm(baseline),
    save,
  };
}
