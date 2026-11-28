// The PC's price sheet for the business owner: every row of the price list in one spreadsheet,
// changed where it stands, typed or pasted from Excel, with new rows at the end. Search and the
// repair type narrow what the sheet shows without losing a change made elsewhere on it. Saving sends
// only what changed (new, changed and removed rows, and this store's prices) in runs, so a thousand
// rows go in without one bad row holding up the rest; a row the device refused stays, saying why.
import { errorCodeOrUnexpected, refusalKeyOf } from '@bolusi/core';
import { translateFailure } from '@bolusi/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';

import { lookUpFit } from '../../inventory/bulk-form.js';
import type { FitMatch } from '../../inventory/bulk-entry.js';
import { splitList } from '../../inventory/bulk-entry.js';
import { compactModel } from '../../shared/model-key.js';
import { tn } from '../i18n.js';
import { catalogModelSearch } from '../model-search.js';
import { MAX_PRICES_PER_SAVE } from '../prices.commands.js';
import {
  PRICE_COLUMNS,
  priceCells,
  readPriceRow,
  repeatedRows,
  type ReadPriceRow,
  type SheetProblem,
} from '../price-sheet.js';
import type { PriceType } from '../price-terms.js';
import { MAX_PRICE_PAGE, type PriceRow } from '../prices.queries.js';
import { useRepairQuery, useRepairRuntime } from '../runtime.js';

export interface SheetRow {
  readonly id: string;
  readonly cells: Readonly<Record<string, string>>;
}

let rowSeq = 0;
const NEW = 'new:';
export const newSheetRow = (): SheetRow => ({ id: `${NEW}${String((rowSeq += 1))}`, cells: {} });
const isNew = (id: string): boolean => id.startsWith(NEW);

export interface SheetProgress {
  readonly done: number;
  readonly total: number;
}

export interface PriceSheet {
  /** Null while the list loads. */
  readonly loaded: boolean;
  /** The rows the sheet shows now: the list narrowed by search and type, then the new rows. */
  readonly rows: readonly SheetRow[];
  readonly setRows: (rows: readonly SheetRow[]) => void;
  /** Each shown row read, by row id. */
  readonly read: ReadonlyMap<string, ReadPriceRow>;
  readonly problems: ReadonlyMap<string, Readonly<Record<string, SheetProblem>>>;
  /** Why the device refused a row's save, by row id. */
  readonly refused: ReadonlyMap<string, string>;
  /** Rows changed, added or removed: what a save would send. */
  readonly changes: number;
  /** Changes that cannot be saved yet (a missing or wrong cell). */
  readonly blocked: number;
  readonly progress: SheetProgress | null;
  readonly notice: string | null;
  readonly clearNotice: () => void;
  /** Changes when saved rows leave the sheet's history, so its undo forgets them. */
  readonly saves: number;
  readonly save: () => Promise<void>;
  readonly discard: () => void;
}

interface Edits {
  /** Saved rows' cells as changed, by price id. */
  readonly changed: ReadonlyMap<string, Readonly<Record<string, string>>>;
  /** New rows, in the order typed. */
  readonly added: readonly SheetRow[];
  /** Saved rows taken off the sheet. */
  readonly removed: ReadonlySet<string>;
}

const NO_EDITS: Edits = { changed: new Map(), added: [], removed: new Set() };

const sameCells = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) =>
  PRICE_COLUMNS.every((id) => (a[id] ?? '').trim() === (b[id] ?? '').trim());

export function usePriceSheet({
  types,
  text,
  repairType,
  storeColumn,
}: {
  readonly types: readonly PriceType[];
  /** Phones typed to narrow the sheet; '' shows every row. */
  readonly text: string;
  readonly repairType: string | null;
  readonly storeColumn: boolean;
}): PriceSheet {
  const runtime = useRepairRuntime();
  const search = useMemo(() => catalogModelSearch(runtime), [runtime]);
  const [edits, setEdits] = useState<Edits>(NO_EDITS);
  const [strict, setStrict] = useState(false);
  const [refused, setRefused] = useState<ReadonlyMap<string, string>>(new Map());
  const [progress, setProgress] = useState<SheetProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saves, setSaves] = useState(0);
  const [fits, setFits] = useState<ReadonlyMap<string, FitMatch>>(new Map());
  const asked = useRef(new Map<string, Promise<FitMatch>>());

  const all = useRepairQuery<readonly PriceRow[]>(
    async (rt) => (await rt.query('priceList', { limit: MAX_PRICE_PAGE })).rows,
    'priceSheet.all',
  );
  const shownIds = useRepairQuery<ReadonlySet<string> | null>(
    async (rt) =>
      text.trim() === '' && repairType === null
        ? null
        : new Set(
            (await rt.query('priceList', { text, repairType, limit: MAX_PRICE_PAGE })).rows.map(
              (row) => row.id,
            ),
          ),
    `priceSheet.shown:${text}:${repairType ?? ''}`,
  );
  const saved = all.status === 'ready' ? all.data : null;
  const savedCells = useMemo(
    () => new Map((saved ?? []).map((row) => [row.id, priceCells(row, types)])),
    [saved, types],
  );

  const rows = useMemo((): SheetRow[] => {
    const narrow = shownIds.status === 'ready' ? shownIds.data : null;
    const listed = (saved ?? [])
      .filter((row) => !edits.removed.has(row.id) && (narrow === null || narrow.has(row.id)))
      .map((row) => ({
        id: row.id,
        cells: edits.changed.get(row.id) ?? savedCells.get(row.id) ?? {},
      }));
    return [...listed, ...edits.added];
  }, [saved, savedCells, edits, shownIds]);

  // Each phone typed on the sheet, looked up once in the catalog.
  const typedPhones = useMemo(() => {
    const phones = new Set<string>();
    for (const row of [...edits.changed.values(), ...edits.added.map((r) => r.cells)]) {
      for (const typed of splitList(row['models'] ?? '')) phones.add(typed);
    }
    return [...phones];
  }, [edits]);
  const lookUp = async (phones: readonly string[]): Promise<Map<string, FitMatch>> => {
    const found = new Map<string, FitMatch>();
    let fresh = false;
    for (const typed of phones) {
      const key = compactModel(typed);
      let pending = asked.current.get(key);
      if (pending === undefined) {
        pending = lookUpFit(search, typed);
        asked.current.set(key, pending);
        fresh = true;
      }
      found.set(key, await pending);
    }
    if (fresh) setFits((current) => new Map([...current, ...found]));
    return found;
  };
  useEffect(() => {
    void lookUp(typedPhones);
  }, [typedPhones]);

  // A saved row's phones are already the catalog's spelling (or were kept as typed on purpose).
  const savedFit = useMemo(() => {
    const map = new Map<string, FitMatch>();
    for (const row of saved ?? []) {
      for (const model of row.models) {
        const fit = { brand: model.brand, model: model.model };
        map.set(compactModel(`${model.brand} ${model.model}`.trim()), { exact: fit, near: null });
      }
    }
    return map;
  }, [saved]);

  const readAll = (
    sheet: readonly SheetRow[],
    strictNow: boolean,
    known: ReadonlyMap<string, FitMatch>,
  ): Map<string, ReadPriceRow> =>
    new Map(
      sheet.map((row) => [
        row.id,
        readPriceRow(row.cells, {
          types,
          storeColumn,
          strict: strictNow,
          fit: (typed) => known.get(compactModel(typed)) ?? savedFit.get(compactModel(typed)),
        }),
      ]),
    );

  // Every row that would be saved, read: the changed and new ones, wherever the sheet is narrowed.
  const pending = useMemo(
    () => [
      ...[...edits.changed].map(([id, cells]) => ({ id, cells })),
      ...edits.added.filter((row) => PRICE_COLUMNS.some((c) => (row.cells[c] ?? '').trim() !== '')),
    ],
    [edits],
  );
  const read = useMemo(
    () => readAll([...rows, ...pending], strict, fits),
    [rows, pending, strict, fits, types, storeColumn, savedFit],
  );

  // A phone priced twice for one repair and quality, across the whole list as it would read.
  const repeats = useMemo(() => {
    const everyRow = [
      ...(saved ?? [])
        .filter((row) => !edits.removed.has(row.id) && !edits.changed.has(row.id))
        .map((row) => ({
          id: row.id,
          read: { repairType: row.repairType, quality: row.quality, models: row.models },
        })),
      ...pending.map((row) => ({ id: row.id, read: read.get(row.id)! })),
    ];
    return repeatedRows(everyRow);
  }, [saved, edits, pending, read]);

  const problems = useMemo(() => {
    const map = new Map<string, Readonly<Record<string, SheetProblem>>>();
    for (const [id, r] of read) {
      const found: Record<string, SheetProblem> = { ...r.problems };
      const repeat = repeats.get(id);
      if (repeat !== undefined && (isNew(id) || edits.changed.has(id))) {
        found['models'] = {
          tone: 'danger',
          message: tn('repair.prices.sheet.repeated', { model: repeat.model }),
        };
      }
      if (Object.keys(found).length > 0) map.set(id, found);
    }
    return map;
  }, [read, repeats, edits]);

  const blockedIds = pending
    .map((row) => row.id)
    .filter(
      (id) =>
        !(read.get(id)?.ready ?? false) ||
        Object.values(problems.get(id) ?? {}).some((p) => p.tone === 'danger'),
    );
  const changes = pending.length + edits.removed.size;

  const setRows = (next: readonly SheetRow[]): void => {
    setEdits((current) => {
      const changed = new Map(current.changed);
      const removed = new Set(current.removed);
      const shown = new Set(rows.map((row) => row.id));
      const kept = new Set(next.map((row) => row.id));
      for (const row of next) {
        if (isNew(row.id)) continue;
        const base = savedCells.get(row.id);
        if (base !== undefined && sameCells(base, row.cells)) changed.delete(row.id);
        else changed.set(row.id, row.cells);
      }
      for (const id of shown) {
        if (!kept.has(id) && !isNew(id)) {
          removed.add(id);
          changed.delete(id);
        }
      }
      const added = next.filter((row) => isNew(row.id));
      return { changed, added, removed };
    });
    if (refused.size > 0) {
      const ids = new Set(next.map((r) => r.id));
      setRefused(new Map([...refused].filter(([id]) => ids.has(id))));
    }
  };

  const save = async (): Promise<void> => {
    if (progress !== null) return;
    setStrict(true);
    setNotice(null);
    // Phones still being looked up are looked up first, so none is saved as typed by accident.
    const latest = new Map([...fits, ...(await lookUp(typedPhones))]);
    const now = readAll(pending, true, latest);
    const ready = pending.filter(
      (row) =>
        now.get(row.id)?.ready === true &&
        !Object.values(problems.get(row.id) ?? {}).some((p) => p.tone === 'danger'),
    );
    const left = pending.length - ready.length;
    const removals = [...edits.removed];
    if (ready.length === 0 && removals.length === 0) {
      if (left > 0) setNotice(tn('repair.prices.sheet.left', { count: left }));
      return;
    }
    const total = ready.length + removals.length;
    setProgress({ done: 0, total });
    const done = new Set<string>();
    const failed = new Map<string, string>();
    const why = (error: unknown): string =>
      translateFailure(refusalKeyOf(error) ?? errorCodeOrUnexpected(error));
    const savedById = new Map((saved ?? []).map((row) => [row.id, row]));

    // What saving a row sends: the list's part when it changed, and this store's own price when
    // that changed (a new row's after its id is minted).
    // A new row's id once its list part is saved, so trying the row again changes that row
    // instead of adding a second one.
    const minted = new Map<string, string>();
    const plan = (row: SheetRow) => {
      const r = now.get(row.id)!;
      const before = savedById.get(row.id);
      const knownId = before?.id ?? minted.get(row.id);
      const listChanged =
        before === undefined ||
        before.repairType !== r.repairType ||
        before.quality !== r.quality ||
        before.listAmount !== r.amount ||
        before.models.map((m) => compactModel(m.brand, m.model)).join() !==
          r.models.map((m) => compactModel(m.brand, m.model)).join();
      return {
        row,
        list: listChanged
          ? {
              ...(knownId === undefined ? {} : { priceId: knownId }),
              repairType: r.repairType!,
              models: r.models.map(({ brand, model }) => ({ brand, model })),
              quality: r.quality,
              amount: r.amount,
            }
          : null,
        priceId: knownId,
        store:
          storeColumn && (before?.storeAmount ?? null) !== r.storeAmount
            ? { amount: r.storeAmount }
            : null,
      };
    };
    const send = async (batch: readonly SheetRow[]): Promise<void> => {
      const plans = batch.map(plan);
      const listed = plans.filter((p) => p.list !== null);
      const ids = new Map<string, string>();
      if (listed.length > 0) {
        const result = await runtime.run('savePrices', { rows: listed.map((p) => p.list!) });
        listed.forEach((p, i) => {
          ids.set(p.row.id, result.priceIds[i]!);
          minted.set(p.row.id, result.priceIds[i]!);
        });
      }
      const prices = plans
        .filter((p) => p.store !== null)
        .map((p) => ({ priceId: ids.get(p.row.id) ?? p.priceId!, amount: p.store!.amount }));
      if (prices.length > 0) await runtime.run('setStorePrices', { prices });
    };

    // Rows go in runs; a run refused is tried row by row, so one bad row holds up only itself.
    for (let at = 0; at < ready.length; at += MAX_PRICES_PER_SAVE) {
      const batch = ready.slice(at, at + MAX_PRICES_PER_SAVE);
      try {
        await send(batch);
        for (const row of batch) done.add(row.id);
      } catch {
        for (const row of batch) {
          try {
            await send([row]);
            done.add(row.id);
          } catch (error) {
            failed.set(row.id, why(error));
          }
        }
      }
      setProgress({ done: done.size + failed.size, total });
    }
    for (let at = 0; at < removals.length; at += MAX_PRICES_PER_SAVE) {
      const batch = removals.slice(at, at + MAX_PRICES_PER_SAVE);
      try {
        await runtime.run('removePrices', { priceIds: batch });
        for (const id of batch) done.add(id);
      } catch {
        for (const id of batch) {
          try {
            await runtime.run('removePrices', { priceIds: [id] });
            done.add(id);
          } catch (error) {
            failed.set(id, why(error));
          }
        }
      }
      setProgress({ done: done.size + failed.size, total });
    }

    setEdits((current) => ({
      changed: new Map([...current.changed].filter(([id]) => !done.has(id))),
      added: current.added.filter((row) => !done.has(row.id)),
      removed: new Set([...current.removed].filter((id) => !done.has(id))),
    }));
    setRefused(failed);
    setSaves((n) => n + 1);
    setProgress(null);
    setStrict(failed.size > 0 || left > 0);
    setNotice(
      [
        done.size > 0 ? tn('repair.prices.sheet.saved', { count: done.size }) : '',
        left + failed.size > 0 ? tn('repair.prices.sheet.left', { count: left + failed.size }) : '',
      ]
        .filter((s) => s !== '')
        .join(' '),
    );
  };

  return {
    loaded: saved !== null,
    rows,
    setRows,
    read,
    problems,
    refused,
    changes,
    blocked: blockedIds.length,
    progress,
    notice,
    clearNotice: () => setNotice(null),
    saves,
    save,
    discard: () => {
      setEdits(NO_EDITS);
      setStrict(false);
      setRefused(new Map());
      setNotice(null);
      setSaves((n) => n + 1);
    },
  };
}
