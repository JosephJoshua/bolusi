// What the counter goes through with the customer before the phone goes home, the same on the phone
// and the PC: the store's handover checks on a repaired phone, then each accessory left at intake.
// Anything left unticked needs the handover note to say why (`handoverProblem`).
import { useMemo, useState } from 'react';

import { tn } from './i18n.js';
import {
  DEFAULT_INTAKE_OPTIONS,
  handoverChecklist,
  handoverProblem,
  storeIntakeOptions,
  type HandoverCheck,
} from './intake-options.js';
import { optionLabel } from './labels.js';
import type { TicketDetailRow } from './queries.js';
import { useIntakeOptionSettings } from './runtime.js';

export interface HandoverChecks {
  /** Every line, ticked or not; empty until the store's list loads. */
  readonly lines: readonly HandoverCheck[];
  readonly toggle: (line: HandoverCheck) => void;
  /** The store's list has loaded, so the lines are the whole checklist. */
  readonly loaded: boolean;
  /** Something is left unticked, so the note must say why. */
  readonly noteNeeded: boolean;
  /** The counter has ticked something worth asking about before leaving. */
  readonly touched: boolean;
  /** Whether the handover may go ahead with this note. */
  readonly ready: (note: string) => boolean;
  /** The lines ticked, as `kind:item`, as a kept handover holds them (`HandoverDraft`). */
  readonly ticked: readonly string[];
}

const keyOf = (line: Pick<HandoverCheck, 'kind' | 'item'>): string => `${line.kind}:${line.item}`;

/** A line as the counter reads it: the check's name, or "Charger dikembalikan". */
export function handoverLineLabel(line: HandoverCheck): string {
  return line.kind === 'check'
    ? optionLabel('handoverChecks', { id: line.item, label: line.label })
    : tn('repair.handover.accessoryBack', {
        name: optionLabel('accessories', { id: line.item, label: line.label }),
      });
}

export function useHandoverChecks(
  ticket: Pick<TicketDetailRow, 'outcome' | 'peripherals'> | undefined,
  /** A kept handover's ticks, restored as they were. */
  restored?: readonly string[] | null,
): HandoverChecks {
  const settings = useIntakeOptionSettings();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(restored ?? []));
  // A list that cannot be read never blocks the handover: the app's own checks stand in for it.
  const loaded = settings.status !== 'loading' && ticket !== undefined;
  const offered = useMemo(
    () =>
      settings.status === 'loading'
        ? null
        : settings.status === 'ready'
          ? storeIntakeOptions(settings.data).handoverChecks
          : DEFAULT_INTAKE_OPTIONS.handoverChecks,
    [settings],
  );
  const lines = useMemo(
    () =>
      ticket === undefined || offered === null
        ? []
        : handoverChecklist(ticket.outcome, ticket.peripherals, offered).map((line) => ({
            ...line,
            done: ticked.has(keyOf(line)),
          })),
    [ticket, offered, ticked],
  );
  const toggle = (line: HandoverCheck): void =>
    setTicked((current) => {
      const next = new Set(current);
      if (!next.delete(keyOf(line))) next.add(keyOf(line));
      return next;
    });
  return {
    lines,
    toggle,
    loaded,
    noteNeeded: lines.some((line) => !line.done),
    touched: ticked.size > 0,
    ready: (note) =>
      loaded && ticket !== undefined && handoverProblem(lines, ticket.peripherals, note) === null,
    ticked: [...ticked],
  };
}
