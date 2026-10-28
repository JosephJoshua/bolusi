// The paper a device prints slips on: a setting of the device, picked once in its settings, not at
// every print. A phone prints cut sheets through the system dialog; a counter PC also has the
// store's carbonless dot-matrix forms. A saved size this device cannot print falls back to its first.
import { PAPER_PRESETS, type PaperSettings } from '@bolusi/core';
import { useCallback, useEffect, useState } from 'react';

import type { RepairKey } from './i18n.js';
import type { DevicePrinter, DevicePrinters, RepairPrinting } from './runtime.js';

/** The sizes a slip prints on; core's landscape and custom sizes wait for a store that needs them. */
export type PaperChoice = 'continuous_half' | 'continuous_full' | 'a4' | 'a5';

export const PHONE_PAPERS: readonly PaperChoice[] = ['a4', 'a5'];
export const DESK_PAPERS: readonly PaperChoice[] = [
  'continuous_half',
  'continuous_full',
  'a4',
  'a5',
];

export const PAPER_KEY: Readonly<Record<PaperChoice, RepairKey>> = {
  continuous_half: 'repair.print.paperHalf',
  continuous_full: 'repair.print.paperFull',
  a4: 'repair.print.paperA4',
  a5: 'repair.print.paperA5',
};

/** The paper this device prints on: the saved one when it can print it, else its first. */
export function paperFor(saved: PaperSettings | null, papers: readonly PaperChoice[]): PaperChoice {
  const preset = saved?.preset;
  return papers.find((choice) => choice === preset) ?? papers[0]!;
}

export async function readDevicePaper(
  printing: RepairPrinting,
  papers: readonly PaperChoice[],
): Promise<PaperSettings> {
  return PAPER_PRESETS[paperFor(await printing.readPaper(), papers)];
}

/**
 * The device's paper for a settings screen or a print caption: null until read, and a setter that
 * saves it at once, so there is nothing to forget to save.
 */
export function useDevicePaper(
  printing: RepairPrinting | undefined,
  papers: readonly PaperChoice[],
): readonly [PaperChoice | null, (paper: PaperChoice) => Promise<void>] {
  const [paper, setPaper] = useState<PaperChoice | null>(null);
  useEffect(() => {
    if (printing === undefined) return;
    let live = true;
    void printing.readPaper().then((saved) => {
      if (live) setPaper(paperFor(saved, papers));
    });
    return () => {
      live = false;
    };
  }, [printing, papers]);
  const choose = useCallback(
    async (next: PaperChoice): Promise<void> => {
      if (printing === undefined) return;
      const before = paper;
      setPaper(next);
      try {
        await printing.writePaper(PAPER_PRESETS[next]);
      } catch {
        // Not saved: show the paper prints will still use.
        setPaper(before);
      }
    },
    [printing, paper],
  );
  return [paper, choose];
}

export type DevicePrintersState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | {
      readonly kind: 'ready';
      readonly printers: readonly DevicePrinter[];
      /** The chosen printer's name, even when it is no longer installed; null before a pick. */
      readonly chosen: string | null;
    };

/** Every screen showing a PC's printers, so a choice made in one is read again by the others. */
const printerReaders = new WeakMap<DevicePrinters, Set<() => void>>();

/**
 * The device's printers for its settings screen: the list as the system has it now, the one chosen,
 * a pick that saves at once, and a reload for a printer plugged in after the screen opened.
 */
export function useDevicePrinters(printers: DevicePrinters | undefined): {
  readonly state: DevicePrintersState;
  readonly choose: (name: string) => Promise<void>;
  readonly reload: () => void;
} {
  const [state, setState] = useState<DevicePrintersState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (printers === undefined) return;
    let live = true;
    setState({ kind: 'loading' });
    void Promise.all([printers.list(), printers.chosen()]).then(
      ([list, chosen]) => {
        if (live) setState({ kind: 'ready', printers: list, chosen });
      },
      () => {
        if (live) setState({ kind: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [printers, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const choose = useCallback(
    async (name: string): Promise<void> => {
      if (printers === undefined || state.kind !== 'ready') return;
      const before = state;
      setState({ ...state, chosen: name });
      try {
        await printers.choose(name);
      } catch {
        // Not saved: show the printer prints will still use.
        setState(before);
        return;
      }
      for (const read of printerReaders.get(printers) ?? []) if (read !== reload) read();
    },
    [printers, state, reload],
  );
  useEffect(() => {
    if (printers === undefined) return;
    const readers = printerReaders.get(printers) ?? new Set();
    printerReaders.set(printers, readers);
    readers.add(reload);
    return () => {
      readers.delete(reload);
    };
  }, [printers, reload]);
  return { state, choose, reload };
}
