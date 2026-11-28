// One item's actions on the phone and the PC: counting what is on the shelf (Koreksi stok), and
// archiving or restoring the item. The screens only draw them.
import { useState } from 'react';

import { useActionRunner, type ActionRunner } from '../screen-kit/index.js';

import { countNeedsReason } from './constants.js';
import { ti } from './i18n.js';
import { itemDetails, type ItemDetailRow, type ItemRow } from './queries.js';
import { useInventoryRuntime } from './runtime.js';

export interface CountStockForm {
  readonly runner: ActionRunner;
  /** What the store has on record now. */
  readonly recorded: number;
  readonly counted: number;
  readonly setCounted: (counted: number) => void;
  readonly note: string;
  readonly setNote: (note: string) => void;
  /** The count less the record: what saving changes. */
  readonly difference: number;
  /** The record and the difference in words, said under the count as it changes. */
  readonly caption: string;
  readonly dirty: boolean;
  /** The count lowers stock, so the note is a required reason. */
  readonly needsReason: boolean;
  /** A save was tried without the reason it needs. */
  readonly reasonMissing: boolean;
  readonly save: () => void;
}

/** The count starts at the record (never below zero), so a matching count is one tap. */
export function useCountStock(part: ItemRow, onDone: () => void): CountStockForm {
  const runtime = useInventoryRuntime();
  const runner = useActionRunner();
  const recorded = part.onHand;
  const start = Math.max(0, recorded);
  const [counted, setCounted] = useState(start);
  const [note, setNote] = useState('');
  const [noReason, setNoReason] = useState(false);
  const needsReason = countNeedsReason(counted, recorded);

  const save = (): void => {
    if (needsReason && note.trim() === '') {
      setNoReason(true);
      return;
    }
    void runner
      .run(() =>
        runtime.run('countStock', {
          counts: [{ itemId: part.id, counted }],
          note: note.trim() === '' ? null : note,
        }),
      )
      .then((result) => {
        if (result !== undefined) onDone();
      });
  };

  const difference = counted - recorded;
  return {
    runner,
    recorded,
    counted,
    setCounted,
    note,
    setNote: (next) => {
      setNote(next);
      setNoReason(false);
    },
    difference,
    caption: `${ti('inventory.count.recorded', { count: recorded })} · ${
      difference === 0
        ? ti('inventory.count.same')
        : difference > 0
          ? ti('inventory.count.more', { count: difference })
          : ti('inventory.count.less', { count: -difference })
    }`,
    dirty: counted !== start || note !== '',
    needsReason,
    reasonMissing: needsReason && noReason,
    save,
  };
}

/** Archives or restores an item, keeping its details; `onDone` says which landed. */
export function useArchiveItem(onDone: (archived: boolean) => void): {
  readonly runner: ActionRunner;
  readonly setArchived: (row: ItemDetailRow, archived: boolean) => void;
} {
  const runtime = useInventoryRuntime();
  const runner = useActionRunner();
  return {
    runner,
    setArchived: (row, archived) => {
      void runner
        .run(() => runtime.run('editItem', { itemId: row.id, archived, ...itemDetails(row) }))
        .then((result) => {
          if (result !== undefined) onDone(archived);
        });
    },
  };
}
