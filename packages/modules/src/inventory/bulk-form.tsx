// The PC's sheet for entering many items at once (bulk-entry.ts reads each row): the chosen
// category, the rows, the phone catalog's answer for each phone typed, and saving the ready rows in
// runs of `addItems`, so a thousand rows go in without one bad row holding up the rest. Rows that
// were saved leave the sheet; a row the device refused stays, saying why.
import { errorCodeOrUnexpected, refusalKeyOf } from '@bolusi/core';
import { translateFailure } from '@bolusi/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';

import { compactModel } from '../shared/model-key.js';
import {
  bulkColumns,
  splitList,
  readRow,
  type BulkColumn,
  type FitMatch,
  type ReadRow,
} from './bulk-entry.js';
import { valueKey } from './categories.js';
import { INVENTORY_PERMISSION, MAX_ITEMS_PER_ADD, TAG_FACET } from './constants.js';
import { ti } from './i18n.js';
import type { CategoryRow, FacetValueRow } from './queries.js';
import { useInventoryQuery, useInventoryRuntime } from './runtime.js';

export interface BulkRow {
  readonly id: string;
  readonly cells: Readonly<Record<string, string>>;
}

let rowSeq = 0;
export const newBulkRow = (): BulkRow => ({ id: `bulk${String((rowSeq += 1))}`, cells: {} });

export interface BulkProgress {
  readonly done: number;
  readonly total: number;
}

export interface BulkEntry {
  readonly categories: readonly CategoryRow[];
  readonly category: CategoryRow | null;
  readonly pickCategory: (categoryId: string | null) => void;
  readonly columns: readonly BulkColumn[];
  readonly rows: readonly BulkRow[];
  readonly setRows: (rows: readonly BulkRow[]) => void;
  /** Each row read, in the rows' order. */
  readonly read: readonly ReadRow[];
  readonly filled: number;
  readonly ready: number;
  /** Values to offer while typing in a column, most used first. */
  readonly suggestions: (column: BulkColumn) => readonly string[];
  /** Why the device refused a row's save, by row id. */
  readonly refused: ReadonlyMap<string, string>;
  readonly canCount: boolean;
  /** Set while saving. */
  readonly progress: BulkProgress | null;
  /** What the last save did. */
  readonly notice: string | null;
  /** How many rows the last save left on the sheet to fix. */
  readonly left: number;
  readonly clearNotice: () => void;
  /** Changes when saved rows leave the sheet, so the sheet's undo forgets them. */
  readonly saves: number;
  readonly save: () => Promise<void>;
}

/** The catalog's answer for a typed phone: the same spelling, else the closest model. */
async function lookUpFit(
  search: (text: string, limit: number) => Promise<readonly { brand: string; model: string }[]>,
  typed: string,
): Promise<FitMatch> {
  const found = await search(typed, 5).catch(() => []);
  const key = compactModel(typed);
  const exact = found.find(
    (option) =>
      compactModel(option.brand, option.model) === key || compactModel(option.model) === key,
  );
  const pick = (o: { brand: string; model: string } | undefined) =>
    o === undefined ? null : { brand: o.brand, model: o.model };
  return { exact: pick(exact), near: exact === undefined ? pick(found[0]) : null };
}

export function useBulkEntry(): BulkEntry {
  const runtime = useInventoryRuntime();
  const canCount = runtime.hasPermission(INVENTORY_PERMISSION.count);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [rows, setRows] = useState<readonly BulkRow[]>(() => [newBulkRow()]);
  const [strict, setStrict] = useState(false);
  const [refused, setRefused] = useState<ReadonlyMap<string, string>>(new Map());
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [saves, setSaves] = useState(0);
  const [fits, setFits] = useState<ReadonlyMap<string, FitMatch>>(new Map());
  // One lookup per phone, kept as its promise so a save waits for one still under way.
  const asked = useRef(new Map<string, Promise<FitMatch>>());

  const categoryList = useInventoryQuery<readonly CategoryRow[]>(
    async (rt) => (await rt.query('listCategories', {})).rows,
    'bulk.categories',
  );
  const categories = categoryList.status === 'ready' ? categoryList.data : [];
  const category = categories.find((c) => c.id === categoryId) ?? null;
  const facetList = useInventoryQuery<readonly FacetValueRow[]>(
    async (rt) => [
      ...(categoryId === null
        ? []
        : (await rt.query('facetValues', { categoryId })).rows.filter(
            (row) => row.facet !== TAG_FACET,
          )),
      ...(await rt.query('facetValues', {})).rows.filter((row) => row.facet === TAG_FACET),
    ],
    `bulk.facets:${categoryId ?? ''}`,
  );
  const facets = facetList.status === 'ready' ? facetList.data : [];
  const columns = useMemo(() => bulkColumns(category, canCount), [category, canCount]);

  // A field's own choices first, then what items already hold; tags as the list spells them.
  const known = useMemo(() => {
    const byFacet = new Map<string, string[]>();
    const add = (facet: string, value: string): void => {
      const list = byFacet.get(facet) ?? [];
      if (!list.some((v) => valueKey(v) === valueKey(value))) list.push(value);
      byFacet.set(facet, list);
    };
    for (const field of category?.fields ?? []) for (const o of field.options) add(field.id, o);
    for (const row of facets) add(row.facet, row.value);
    return byFacet;
  }, [category, facets]);
  const spellings = useMemo(() => {
    const map = new Map<string, string>();
    for (const [facet, values] of known) {
      for (const value of values) map.set(`${facet}\u0000${valueKey(value)}`, value);
    }
    return map;
  }, [known]);

  // Each phone typed in the sheet, looked up once in the catalog.
  const fitsColumn = columns.some((c) => c.kind === 'fits');
  const typedPhones = useMemo(() => {
    if (!fitsColumn) return [];
    const all = new Set<string>();
    for (const row of rows) for (const typed of splitList(row.cells['fits'] ?? '')) all.add(typed);
    return [...all];
  }, [rows, fitsColumn]);
  const lookUp = async (phones: readonly string[]): Promise<Map<string, FitMatch>> => {
    const search = runtime.searchModels;
    const found = new Map<string, FitMatch>();
    if (search === undefined) return found;
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

  const readAll = (strictNow: boolean, known: ReadonlyMap<string, FitMatch>): ReadRow[] =>
    rows.map((row) =>
      readRow(row.cells, {
        category,
        columns,
        strict: strictNow,
        spelling: (facet, value) => spellings.get(`${facet}\u0000${valueKey(value)}`),
        fit: (typed) =>
          runtime.searchModels === undefined
            ? { exact: { brand: '', model: typed }, near: null }
            : known.get(compactModel(typed)),
      }),
    );
  const read = useMemo(
    () => readAll(strict, fits),
    [rows, category, columns, strict, spellings, fits],
  );

  const save = async (): Promise<void> => {
    if (progress !== null) return;
    setStrict(true);
    setNotice(null);
    // Phones still being looked up are looked up first, so none is saved as typed by accident.
    const latest = new Map([...fits, ...(await lookUp(typedPhones))]);
    const now = readAll(true, latest);
    const ready = rows.map((row, i) => ({ row, read: now[i]! })).filter(({ read: r }) => r.ready);
    const waiting = now.filter((r) => r.filled && !r.ready).length;
    if (ready.length === 0) {
      setLeft(waiting);
      if (waiting > 0) setNotice(ti('inventory.bulk.left', { count: waiting }));
      return;
    }
    setProgress({ done: 0, total: ready.length });
    const saved = new Set<string>();
    const failed = new Map<string, string>();
    const send = (batch: typeof ready) =>
      runtime.run('addItems', { items: batch.map(({ read: r }) => r.item) });
    for (let at = 0; at < ready.length; at += MAX_ITEMS_PER_ADD) {
      const batch = ready.slice(at, at + MAX_ITEMS_PER_ADD);
      try {
        await send(batch);
        for (const { row } of batch) saved.add(row.id);
      } catch {
        // One save is all or none: find the rows the device refuses, and save the rest.
        for (const one of batch) {
          try {
            await send([one]);
            saved.add(one.row.id);
          } catch (error) {
            failed.set(
              one.row.id,
              translateFailure(refusalKeyOf(error) ?? errorCodeOrUnexpected(error)),
            );
          }
        }
      }
      setProgress({ done: saved.size + failed.size, total: ready.length });
    }
    setRows((current) => {
      const kept = current.filter((row) => !saved.has(row.id));
      return kept.length === 0 ? [newBulkRow()] : kept;
    });
    setRefused(failed);
    setSaves((n) => n + 1);
    setProgress(null);
    // The rows left are the ones to fix; nothing to say about them until saving is tried again.
    setStrict(failed.size > 0 || waiting > 0);
    setLeft(waiting + failed.size);
    setNotice(
      [
        saved.size > 0 ? ti('inventory.bulk.saved', { count: saved.size }) : '',
        waiting + failed.size > 0
          ? ti('inventory.bulk.left', { count: waiting + failed.size })
          : '',
      ]
        .filter((s) => s !== '')
        .join(' '),
    );
  };

  return {
    categories,
    category,
    pickCategory: (id) => {
      setCategoryId(id);
      setRows([newBulkRow()]);
      setStrict(false);
      setRefused(new Map());
      setNotice(null);
      setSaves((n) => n + 1);
    },
    columns,
    rows,
    setRows: (next) => {
      setRows(next);
      if (refused.size > 0) {
        const ids = new Set(next.map((r) => r.id));
        setRefused(new Map([...refused].filter(([id]) => ids.has(id))));
      }
    },
    read,
    filled: read.filter((r) => r.filled).length,
    ready: read.filter((r) => r.ready).length,
    suggestions: (column) =>
      column.kind === 'tags'
        ? (known.get(TAG_FACET) ?? [])
        : column.kind === 'field' && column.field !== undefined && column.field.kind !== 'text'
          ? (known.get(column.field.id) ?? [])
          : [],
    refused,
    canCount,
    progress,
    notice,
    left,
    clearNotice: () => setNotice(null),
    saves,
    save,
  };
}
