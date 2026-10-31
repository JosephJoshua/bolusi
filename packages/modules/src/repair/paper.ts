// The paper a device prints slips on: a setting of the device, picked once in its settings, not at
// every print. A phone prints cut sheets through the system dialog; a counter PC also has the
// store's carbonless dot-matrix forms. A saved size this device cannot print falls back to its first.
import {
  MAX_PAPER_HEIGHT_MM,
  MAX_PAPER_WIDTH_MM,
  MIN_PAPER_MM,
  PAPER_PRESETS,
  zPaperSettings,
  type PaperSettings,
} from '@bolusi/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { tn, type RepairKey } from './i18n.js';
import type { DevicePrinter, DevicePrinters, RepairPrinting } from './runtime.js';

/**
 * The sizes a slip prints on, and a size the store types for paper none of them fits. Core's
 * landscape cut sheets wait for a store that needs them.
 */
export type PaperChoice = 'continuous_half' | 'continuous_full' | 'a4' | 'a5' | 'custom';

export const PHONE_PAPERS: readonly PaperChoice[] = ['a4', 'a5', 'custom'];
export const DESK_PAPERS: readonly PaperChoice[] = [
  'continuous_half',
  'continuous_full',
  'a4',
  'a5',
  'custom',
];

export const PAPER_KEY: Readonly<Record<PaperChoice, RepairKey>> = {
  continuous_half: 'repair.print.paperHalf',
  continuous_full: 'repair.print.paperFull',
  a4: 'repair.print.paperA4',
  a5: 'repair.print.paperA5',
  custom: 'repair.print.paperCustom',
};

/** A size the store typed: the paper's own millimetres, and whether it is tractor-feed. */
export interface CustomPaperSize {
  readonly widthMm: number;
  readonly heightMm: number;
  /** Tractor-feed with punched strips, as the store's carbonless forms; a phone has none. */
  readonly continuous: boolean;
}

/** The paper this device prints on: the saved one when it can print it, else its first. */
export function paperFor(saved: PaperSettings | null, papers: readonly PaperChoice[]): PaperChoice {
  const preset = saved?.preset;
  return papers.find((choice) => choice === preset) ?? papers[0]!;
}

/** The size slips print on: the chosen preset's, or the saved custom size. */
export function paperSettingsFor(
  saved: PaperSettings | null,
  papers: readonly PaperChoice[],
): PaperSettings {
  const choice = paperFor(saved, papers);
  return choice === 'custom' ? saved! : PAPER_PRESETS[choice];
}

/** A custom size as saved, or null when it is outside what a printer can take. */
export function customPaper(size: CustomPaperSize): PaperSettings | null {
  const paper: PaperSettings = {
    preset: 'custom',
    widthMm: Math.round(size.widthMm),
    heightMm: Math.round(size.heightMm),
    continuous: size.continuous,
    // The store's tractor-feed forms are its carbonless ones; one print makes every copy.
    carbonless: size.continuous,
  };
  return zPaperSettings.safeParse(paper).success ? paper : null;
}

/** The paper's name for a caption: the preset's, or "210 × 140 mm" for a typed size. */
export function paperLabel(paper: PaperSettings): string {
  return paper.preset === 'custom'
    ? tn('repair.print.paperSize', { width: paper.widthMm, height: paper.heightMm })
    : tn(PAPER_KEY[paper.preset as Exclude<PaperChoice, 'custom'>]);
}

export async function readDevicePaper(
  printing: RepairPrinting,
  papers: readonly PaperChoice[],
): Promise<PaperSettings> {
  return paperSettingsFor(await printing.readPaper(), papers);
}

export interface DevicePaper {
  /** What slips print on; null until read. */
  readonly paper: PaperSettings | null;
  /** Which choice that is; null until read. */
  readonly choice: PaperChoice | null;
  /** Saves a preset at once; "custom" starts from the paper's current size. */
  readonly choose: (choice: PaperChoice) => Promise<void>;
  /** Saves a typed size; false when it is out of range, and nothing is saved. */
  readonly saveCustom: (size: CustomPaperSize) => Promise<boolean>;
}

/**
 * The device's paper for a settings screen or a print caption: null until read, and setters that
 * save at once, so there is nothing to forget to save.
 */
export function useDevicePaper(
  printing: RepairPrinting | undefined,
  papers: readonly PaperChoice[],
): DevicePaper {
  const [paper, setPaper] = useState<PaperSettings | null>(null);
  useEffect(() => {
    if (printing === undefined) return;
    let live = true;
    void printing.readPaper().then((saved) => {
      if (live) setPaper(paperSettingsFor(saved, papers));
    });
    return () => {
      live = false;
    };
  }, [printing, papers]);
  const save = useCallback(
    async (next: PaperSettings): Promise<void> => {
      if (printing === undefined) return;
      const before = paper;
      setPaper(next);
      try {
        await printing.writePaper(next);
      } catch {
        // Not saved: show the paper prints will still use.
        setPaper(before);
      }
    },
    [printing, paper],
  );
  const choose = useCallback(
    async (next: PaperChoice): Promise<void> => {
      if (next !== 'custom') return save(PAPER_PRESETS[next]);
      if (paper?.preset === 'custom') return;
      const from = paper ?? PAPER_PRESETS[papers[0] === 'custom' ? 'a4' : papers[0]!];
      await save({ ...from, preset: 'custom' });
    },
    [save, paper, papers],
  );
  const saveCustom = useCallback(
    async (size: CustomPaperSize): Promise<boolean> => {
      const next = customPaper(size);
      if (next === null) return false;
      await save(next);
      return true;
    },
    [save],
  );
  return {
    paper,
    choice: paper === null ? null : paperFor(paper, papers),
    choose,
    saveCustom,
  };
}

/** The sizes a printer can take, as one line under the fields. */
export function paperRangeHint(): string {
  return tn('repair.print.paperRange', {
    minWidth: MIN_PAPER_MM,
    maxWidth: MAX_PAPER_WIDTH_MM,
    minHeight: MIN_PAPER_MM,
    maxHeight: MAX_PAPER_HEIGHT_MM,
  });
}

/**
 * The typed size's fields, shared by the phone and the PC: what is typed, saved as it is typed
 * whenever it is a size a printer takes, so leaving the screen straight after the last digit keeps
 * it. A size out of range is not saved; the range turns red once a field is left with it, or at once
 * when a number is already too big to fix by typing on.
 */
export function useCustomPaperForm(device: DevicePaper): {
  readonly width: string;
  readonly height: string;
  readonly setWidth: (value: string) => void;
  readonly setHeight: (value: string) => void;
  readonly continuous: boolean;
  readonly setContinuous: (continuous: boolean) => void;
  /** A field was left: an out-of-range size now shows as such. */
  readonly leave: () => void;
  readonly invalid: boolean;
} {
  const { paper, saveCustom } = device;
  const custom = paper?.preset === 'custom' ? paper : null;
  // The fields start from the saved size, or from it once read. Saves made while typing never
  // write back into them, so a save that lands late cannot undo a digit typed after it.
  const savedWidth = custom?.widthMm;
  const savedHeight = custom?.heightMm;
  const [width, setWidth] = useState(savedWidth === undefined ? '' : String(savedWidth));
  const [height, setHeight] = useState(savedHeight === undefined ? '' : String(savedHeight));
  const [left, setLeft] = useState(false);
  const seeded = useRef(savedWidth !== undefined);
  useEffect(() => {
    if (seeded.current || savedWidth === undefined || savedHeight === undefined) return;
    seeded.current = true;
    setWidth(String(savedWidth));
    setHeight(String(savedHeight));
  }, [savedWidth, savedHeight]);
  const continuous = custom?.continuous ?? false;
  const size = (w: string, h: string, c: boolean): CustomPaperSize => ({
    widthMm: Number(w),
    heightMm: Number(h),
    continuous: c,
  });
  const typed = (w: string, h: string): void => {
    seeded.current = true;
    setWidth(w);
    setHeight(h);
    if (customPaper(size(w, h, continuous)) !== null) void saveCustom(size(w, h, continuous));
  };
  const outOfRange =
    width !== '' && height !== '' && customPaper(size(width, height, continuous)) === null;
  const tooBig = Number(width) > MAX_PAPER_WIDTH_MM || Number(height) > MAX_PAPER_HEIGHT_MM;
  return {
    width,
    height,
    setWidth: (value) => typed(value.replace(/\D/g, ''), height),
    setHeight: (value) => typed(width, value.replace(/\D/g, '')),
    continuous,
    setContinuous: (next) => {
      if (customPaper(size(width, height, next)) !== null)
        void saveCustom(size(width, height, next));
    },
    leave: () => setLeft(true),
    invalid: outOfRange && (left || tooBig),
  };
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
