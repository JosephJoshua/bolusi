// A spreadsheet to fill in many records at one sitting, the way counter staff already know from
// Excel: click or arrow to a cell and type, Enter or F2 to change what is there, Tab and Enter to
// move on, Delete to clear, Ctrl+C / Ctrl+V to copy and paste blocks (straight from Excel or Google
// Sheets, a heading row mapping the columns by name), Ctrl+Z to undo. One empty row always waits at
// the end. Only the rows on screen are rendered, so a thousand stay quick. What is wrong with a
// cell is marked on it and said in the line under the grid when it is selected.
import { useVirtualizer } from '@tanstack/react-virtual';
import { clsx } from 'clsx';
import { AlertCircle, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import {
  boundsOf,
  clearBlock,
  copyBlock,
  inBounds,
  parseClipboardTable,
  pasteBlock,
  toClipboardTable,
  withTrailingRow,
  type CellPos,
  type CellRange,
  type GridRow,
  type PasteColumn,
} from './grid-model.js';
import { Tooltip } from './Tooltip.js';

export type { CellPos, CellRange, GridRow } from './grid-model.js';

export interface GridColumn extends PasteColumn {
  /** Width in px. */
  readonly width: number;
  readonly align?: 'start' | 'end' | undefined;
  /** Shown muted in an empty cell, such as the name the row's other cells build. */
  readonly placeholder?: ((row: GridRow) => string | undefined) | undefined;
  /** Values offered while typing, best first. */
  readonly suggestions?: readonly string[] | undefined;
  /** The cell holds a list separated by commas; suggestions complete its last item. */
  readonly multiple?: boolean | undefined;
  readonly numeric?: boolean | undefined;
  readonly maxLength?: number | undefined;
  /** Said on the heading's tooltip, such as how to write a list. */
  readonly hint?: string | undefined;
}

export interface CellProblem {
  /** `danger` stops the row from being saved; `warning` only says something worth knowing. */
  readonly tone: 'danger' | 'warning';
  readonly message: string;
}

export interface EditableGridLabels {
  readonly row: (n: number) => string;
  readonly deleteRow: string;
  /** "Baris 3, Stok": where the selected cell is, before its problem. */
  readonly where: (row: number, column: string) => string;
}

export interface EditableGridProps {
  readonly columns: readonly GridColumn[];
  readonly rows: readonly GridRow[];
  readonly onChange: (rows: readonly GridRow[]) => void;
  /** A fresh empty row with a new id. */
  readonly newRow: () => GridRow;
  /** Problems by row id, then column id. */
  readonly problems?: ReadonlyMap<string, Readonly<Record<string, CellProblem>>> | undefined;
  /** A problem with a whole row, such as a save that was refused, by row id. */
  readonly rowProblems?: ReadonlyMap<string, string> | undefined;
  /** Shown under the grid while the selected cell has nothing to say. */
  readonly hint?: ReactNode;
  readonly disabled?: boolean | undefined;
  /** Changing it forgets the undo history, such as after the rows were saved and taken out. */
  readonly historyKey?: string | number | undefined;
  readonly labels: EditableGridLabels;
  /** The grid's accessible name. */
  readonly label: string;
  readonly testId?: string | undefined;
}

const ROW_HEIGHT = 40;
const GUTTER = 56;
const HISTORY = 100;
const SUGGESTIONS = 6;
const NO_PROBLEMS: ReadonlyMap<string, Readonly<Record<string, CellProblem>>> = new Map();
const NO_ROW_PROBLEMS: ReadonlyMap<string, string> = new Map();

const START: CellRange = { anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } };

interface Editing {
  readonly row: number;
  readonly col: number;
  readonly value: string;
  /** Started by typing over the cell: arrows then finish the edit and move, as in Excel. */
  readonly typed: boolean;
}

const clampPos = (pos: CellPos, rows: number, cols: number): CellPos => ({
  row: Math.max(0, Math.min(rows - 1, pos.row)),
  col: Math.max(0, Math.min(cols - 1, pos.col)),
});

/** The list item being typed: the text after the last comma. */
function lastItem(value: string): string {
  const at = value.lastIndexOf(',');
  return (at < 0 ? value : value.slice(at + 1)).trim();
}

/** Values that start with (then contain) what is typed, the cell's own items left out. */
export function matchSuggestions(
  options: readonly string[],
  value: string,
  multiple: boolean,
): string[] {
  const typed = (multiple ? lastItem(value) : value.trim()).toLowerCase();
  if (typed === '') return [];
  const taken = new Set(
    (multiple ? value.split(',') : [value]).map((item) => item.trim().toLowerCase()),
  );
  const seen = new Set<string>();
  const unique = options.filter((option) => {
    const key = option.toLowerCase();
    if (seen.has(key) || taken.has(key)) return false;
    seen.add(key);
    return true;
  });
  const starts = unique.filter((option) => option.toLowerCase().startsWith(typed));
  const contains = unique.filter(
    (option) => !option.toLowerCase().startsWith(typed) && option.toLowerCase().includes(typed),
  );
  return [...starts, ...contains].slice(0, SUGGESTIONS);
}

/** A suggestion taken into the cell: the whole value, or the list's last item. */
function takeSuggestion(value: string, option: string, multiple: boolean): string {
  if (!multiple) return option;
  const at = value.lastIndexOf(',');
  return at < 0 ? option : `${value.slice(0, at + 1)} ${option}`;
}

export function EditableGrid({
  columns,
  rows,
  onChange,
  newRow,
  problems = NO_PROBLEMS,
  rowProblems = NO_ROW_PROBLEMS,
  hint,
  disabled = false,
  historyKey,
  labels,
  label,
  testId,
}: EditableGridProps): React.JSX.Element {
  const gridId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [selection, setSelection] = useState<CellRange>(START);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [dragging, setDragging] = useState(false);
  const past = useRef<(readonly GridRow[])[]>([]);
  const future = useRef<(readonly GridRow[])[]>([]);

  useEffect(() => {
    past.current = [];
    future.current = [];
  }, [historyKey]);

  const rowCount = rows.length;
  const colCount = columns.length;
  // A selection can point past the rows for a moment (rows deleted, a move off the spare row).
  const focus = clampPos(selection.focus, rowCount, colCount);
  const bounds = boundsOf({ anchor: clampPos(selection.anchor, rowCount, colCount), focus });
  const template = `${String(GUTTER)}px ${columns.map((c) => `${String(c.width)}px`).join(' ')} minmax(0,1fr)`;
  const innerWidth = GUTTER + columns.reduce((sum, c) => sum + c.width, 0);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  /** Every change goes through here: kept for undo, and the spare row at the end kept. */
  const commitRows = (next: readonly GridRow[]): void => {
    past.current = [...past.current.slice(-(HISTORY - 1)), rows];
    future.current = [];
    onChange(withTrailingRow(next, newRow));
  };

  const setCell = (row: number, col: number, value: string): void => {
    const column = columns[col];
    const target = rows[row];
    if (column === undefined || target === undefined || column.readOnly === true) return;
    if ((target.cells[column.id] ?? '') === value) return;
    commitRows(
      rows.map((r, i) => (i === row ? { ...r, cells: { ...r.cells, [column.id]: value } } : r)),
    );
  };

  const select = (pos: CellPos, extend = false): void => {
    const next = clampPos(pos, rowCount, colCount);
    setSelection((current) =>
      extend ? { anchor: current.anchor, focus: next } : { anchor: next, focus: next },
    );
    virtualizer.scrollToIndex(next.row, { align: 'auto' });
    revealColumn(next.col);
  };

  const revealColumn = (col: number): void => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    const left = GUTTER + columns.slice(0, col).reduce((sum, c) => sum + c.width, 0);
    const right = left + (columns[col]?.width ?? 0);
    if (left - GUTTER < scroller.scrollLeft) scroller.scrollLeft = left - GUTTER;
    else if (right > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = right - scroller.clientWidth;
    }
  };

  // The cell being edited, read synchronously: moving the focus away blurs the box, and that blur
  // must not save the value a second time over what was just saved.
  const editingRef = useRef<Editing | null>(null);
  const edit = (next: Editing | null): void => {
    editingRef.current = next;
    setEditing(next);
  };

  const startEdit = (value?: string): void => {
    if (disabled) return;
    const column = columns[focus.col];
    const row = rows[focus.row];
    if (column === undefined || row === undefined || column.readOnly === true) return;
    setSelection({ anchor: focus, focus });
    setHighlight(0);
    edit({
      row: focus.row,
      col: focus.col,
      value: value ?? row.cells[column.id] ?? '',
      typed: value !== undefined,
    });
  };

  /** Leave the cell: saving `value` (null keeps what it held), then moving by the step given. */
  const endEdit = (value: string | null, step: { rows: number; cols: number } | null): void => {
    const current = editingRef.current;
    if (current === null) return;
    edit(null);
    if (value !== null) setCell(current.row, current.col, value);
    scrollRef.current?.focus({ preventScroll: true });
    if (step === null) return;
    // Filling the spare row adds a new one under it, which a move down may land on.
    const grows = current.row === rowCount - 1 && value !== null && value.trim() !== '';
    const lastRow = grows ? rowCount : rowCount - 1;
    let row = current.row + step.rows;
    let col = current.col + step.cols;
    if (col >= colCount && row < lastRow) {
      row += 1;
      col = 0;
    } else if (col < 0 && row > 0) {
      row -= 1;
      col = colCount - 1;
    }
    const next = {
      row: Math.max(0, Math.min(lastRow, row)),
      col: Math.max(0, Math.min(colCount - 1, col)),
    };
    setSelection({ anchor: next, focus: next });
    virtualizer.scrollToIndex(Math.min(next.row, rowCount - 1), { align: 'auto' });
    revealColumn(next.col);
  };

  const undo = (): void => {
    const previous = past.current.pop();
    if (previous === undefined) return;
    future.current = [...future.current, rows];
    onChange(previous);
  };
  const redo = (): void => {
    const next = future.current.pop();
    if (next === undefined) return;
    past.current = [...past.current, rows];
    onChange(next);
  };

  const deleteRows = (top: number, bottom: number): void => {
    commitRows(rows.filter((_, i) => i < top || i > bottom));
    const at = { row: Math.max(0, Math.min(top, rowCount - 2)), col: focus.col };
    setSelection({ anchor: at, focus: at });
  };

  const paste = (text: string): void => {
    if (disabled) return;
    const block = parseClipboardTable(text);
    const result = pasteBlock({ rows, columns, selection, block, newRow });
    if (result === null) return;
    commitRows(result.rows);
    setSelection(result.range);
    virtualizer.scrollToIndex(result.range.focus.row, { align: 'auto' });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (editing !== null || event.target !== event.currentTarget) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const extend = event.shiftKey;
    const at = focus;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / ROW_HEIGHT) - 1);
    const go = (pos: CellPos): void => {
      event.preventDefault();
      select(pos, extend);
    };
    switch (event.key) {
      case 'ArrowDown':
        return go({ row: ctrl ? rowCount - 1 : at.row + 1, col: at.col });
      case 'ArrowUp':
        return go({ row: ctrl ? 0 : at.row - 1, col: at.col });
      case 'ArrowRight':
        return go({ row: at.row, col: ctrl ? colCount - 1 : at.col + 1 });
      case 'ArrowLeft':
        return go({ row: at.row, col: ctrl ? 0 : at.col - 1 });
      case 'PageDown':
        return go({ row: at.row + page, col: at.col });
      case 'PageUp':
        return go({ row: at.row - page, col: at.col });
      case 'Home':
        return go({ row: ctrl ? 0 : at.row, col: 0 });
      case 'End':
        return go({ row: ctrl ? rowCount - 1 : at.row, col: colCount - 1 });
      case 'Tab': {
        // Leaves the grid from its last cell (or first, backwards), so the keyboard is never stuck.
        const back = event.shiftKey;
        if (back && at.row === 0 && at.col === 0) return;
        if (!back && at.row === rowCount - 1 && at.col === colCount - 1) return;
        event.preventDefault();
        const index = at.row * colCount + at.col + (back ? -1 : 1);
        select({ row: Math.floor(index / colCount), col: index % colCount });
        return;
      }
      case 'Enter':
        event.preventDefault();
        if (event.shiftKey) select({ row: at.row - 1, col: at.col });
        else startEdit();
        return;
      case 'F2':
        event.preventDefault();
        startEdit();
        return;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        if (!disabled) commitRows(clearBlock(rows, columns, bounds));
        return;
      case 'Escape':
        // A block collapses to its cell; Escape on one cell is the page's to handle.
        if (bounds.top !== bounds.bottom || bounds.left !== bounds.right) {
          event.preventDefault();
          event.stopPropagation();
          setSelection({ anchor: at, focus: at });
        }
        return;
      default:
        break;
    }
    if (ctrl && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 'a') {
        event.preventDefault();
        setSelection({
          anchor: { row: 0, col: 0 },
          focus: { row: rowCount - 1, col: colCount - 1 },
        });
      } else if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
        event.preventDefault();
        redo();
      } else if (key === '-' && !disabled) {
        event.preventDefault();
        deleteRows(bounds.top, bounds.bottom);
      }
      return;
    }
    // Typing over a cell replaces what it holds, as in a sheet.
    if (event.key.length === 1 && !event.altKey) {
      event.preventDefault();
      startEdit(event.key);
    }
  };

  const onCopy = (event: ClipboardEvent<HTMLDivElement>, cut: boolean): void => {
    if (editing !== null) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', toClipboardTable(copyBlock(rows, columns, bounds)));
    if (cut && !disabled) commitRows(clearBlock(rows, columns, bounds));
  };

  // A drag across cells selects the block it covers.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: MouseEvent): void => {
      const cell = (document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null)
        ?.closest<HTMLElement>('[data-grid-cell]')
        ?.dataset['gridCell']?.split(':');
      if (cell === undefined) return;
      const pos = { row: Number(cell[0]), col: Number(cell[1]) };
      setSelection((current) => ({ anchor: current.anchor, focus: pos }));
    };
    const onUp = (): void => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  const editingColumn = editing === null ? undefined : columns[editing.col];
  const suggestions = useMemo(
    () =>
      editing === null || editingColumn?.suggestions === undefined
        ? []
        : matchSuggestions(
            editingColumn.suggestions,
            editing.value,
            editingColumn.multiple === true,
          ),
    [editing, editingColumn],
  );

  const menuOpen = suggestions.length > 0 && highlight >= 0;

  const onEditKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (editing === null) return;
    const multiple = editingColumn?.multiple === true;
    const picked = menuOpen
      ? takeSuggestion(editing.value, suggestions[highlight] ?? '', multiple)
      : null;
    switch (event.key) {
      case 'Enter': {
        event.preventDefault();
        if (picked !== null && multiple) {
          edit({ ...editing, value: `${picked}, ` });
          setHighlight(0);
          return;
        }
        endEdit(picked ?? editing.value, { rows: event.shiftKey ? -1 : 1, cols: 0 });
        return;
      }
      case 'Tab':
        event.preventDefault();
        endEdit(picked !== null && !multiple ? picked : editing.value, {
          rows: 0,
          cols: event.shiftKey ? -1 : 1,
        });
        return;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        if (menuOpen) setHighlight(-1);
        else endEdit(null, null);
        return;
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        if (menuOpen) {
          setHighlight((h) => (h + step + suggestions.length) % suggestions.length);
          return;
        }
        endEdit(editing.value, { rows: step, cols: 0 });
        return;
      }
      case 'ArrowLeft':
      case 'ArrowRight':
        // Started by typing, the arrows move on; started with Enter or F2, they move the caret.
        if (editing.typed) {
          event.preventDefault();
          endEdit(editing.value, { rows: 0, cols: event.key === 'ArrowRight' ? 1 : -1 });
        }
        return;
      default:
        return;
    }
  };

  // Where the suggestions open: under the cell being edited, over everything else.
  const [menuAt, setMenuAt] = useState<{ left: number; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (editing === null || input === null || !menuOpen) {
      setMenuAt(null);
      return;
    }
    const rect = input.getBoundingClientRect();
    setMenuAt({ left: rect.left, top: rect.bottom + 2, width: Math.max(rect.width, 200) });
  }, [editing, menuOpen]);

  const activeProblem = problems.get(rows[focus.row]?.id ?? '')?.[columns[focus.col]?.id ?? ''];
  const activeRowProblem = rowProblems.get(rows[focus.row]?.id ?? '');
  const cellId = (row: number, col: number): string => `${gridId}-${String(row)}-${String(col)}`;
  const focusShown = virtualizer.getVirtualItems().some((item) => item.index === focus.row);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid={testId}>
      <div
        ref={scrollRef}
        role="grid"
        aria-label={label}
        aria-rowcount={rowCount + 1}
        aria-colcount={colCount}
        aria-multiselectable
        aria-activedescendant={
          focusShown && editing === null ? cellId(focus.row, focus.col) : undefined
        }
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          if (editing !== null) return;
          event.preventDefault();
          paste(event.clipboardData.getData('text/plain'));
        }}
        onCopy={(event) => onCopy(event, false)}
        onCut={(event) => onCopy(event, true)}
        className="relative min-h-0 flex-1 overflow-auto border-y border-border bg-surface outline-none [scrollbar-gutter:stable] focus-visible:shadow-[inset_0_0_0_2px_var(--b-primary)]"
        data-testid={testId === undefined ? undefined : `${testId}.body`}
      >
        <div style={{ width: innerWidth, minWidth: '100%' }}>
          <div
            role="row"
            className="sticky top-0 z-20 grid h-10 border-b border-border bg-surface-alt"
            style={{ gridTemplateColumns: template }}
          >
            <div className="sticky left-0 z-10 bg-surface-alt" aria-hidden />
            {columns.map((column) => {
              const heading = (
                <div
                  role="columnheader"
                  className={clsx(
                    'flex min-w-0 items-center border-l border-border px-3 text-small font-semibold',
                    column.readOnly === true ? 'text-text-muted' : 'text-text',
                    column.align === 'end' && 'justify-end',
                  )}
                >
                  <span className="truncate">{column.label}</span>
                </div>
              );
              return column.hint === undefined ? (
                <div key={column.id} className="flex min-w-0">
                  {heading}
                </div>
              ) : (
                <Tooltip key={column.id} label={column.hint}>
                  <div className="flex min-w-0 cursor-help">{heading}</div>
                </Tooltip>
              );
            })}
            <div className="border-l border-border" aria-hidden />
          </div>
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]!;
              const rowProblem = rowProblems.get(row.id);
              const rowCells = problems.get(row.id);
              const spare = item.index === rowCount - 1;
              return (
                <div
                  key={row.id}
                  role="row"
                  aria-rowindex={item.index + 2}
                  className="group absolute left-0 top-0 grid w-full border-b border-border"
                  style={{
                    gridTemplateColumns: template,
                    height: ROW_HEIGHT,
                    transform: `translateY(${String(item.start)}px)`,
                  }}
                  data-testid={
                    testId === undefined ? undefined : `${testId}.row.${String(item.index)}`
                  }
                >
                  <div
                    role="rowheader"
                    className={clsx(
                      'sticky left-0 z-10 flex items-center justify-between gap-1 border-r border-border pl-3 pr-1 text-small tabular',
                      rowProblem === undefined
                        ? 'bg-surface-alt text-text-muted'
                        : 'bg-danger-bg text-danger',
                    )}
                  >
                    {rowProblem === undefined ? (
                      <span aria-label={labels.row(item.index + 1)}>{item.index + 1}</span>
                    ) : (
                      <Tooltip label={rowProblem}>
                        <span className="inline-flex items-center gap-1">
                          <AlertCircle size={14} aria-hidden />
                          {item.index + 1}
                        </span>
                      </Tooltip>
                    )}
                    {spare || disabled ? null : (
                      <Tooltip label={labels.deleteRow} shortcut="Ctrl+−">
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label={`${labels.deleteRow} ${String(item.index + 1)}`}
                          onClick={() => deleteRows(item.index, item.index)}
                          className="flex size-6 cursor-pointer items-center justify-center rounded-xs text-text-muted opacity-0 hover:bg-black/5 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                          data-testid={
                            testId === undefined
                              ? undefined
                              : `${testId}.delete.${String(item.index)}`
                          }
                        >
                          <X size={14} aria-hidden />
                        </button>
                      </Tooltip>
                    )}
                  </div>
                  {columns.map((column, col) => {
                    const value = row.cells[column.id] ?? '';
                    const isFocus = focus.row === item.index && focus.col === col;
                    const inBlock = inBounds(bounds, item.index, col);
                    const problem = rowCells?.[column.id];
                    const isEditing =
                      editing !== null && editing.row === item.index && editing.col === col;
                    const placeholder = value === '' ? column.placeholder?.(row) : undefined;
                    return (
                      <div
                        key={column.id}
                        id={cellId(item.index, col)}
                        role="gridcell"
                        aria-selected={inBlock}
                        aria-readonly={column.readOnly === true || undefined}
                        aria-invalid={problem?.tone === 'danger' || undefined}
                        title={problem?.message ?? (value.length > 24 ? value : undefined)}
                        data-grid-cell={`${String(item.index)}:${String(col)}`}
                        data-testid={
                          testId === undefined
                            ? undefined
                            : `${testId}.cell.${String(item.index)}.${column.id}`
                        }
                        onMouseDown={(event) => {
                          if (event.button !== 0) return;
                          if (isEditing) return;
                          event.preventDefault();
                          if (editingRef.current !== null) endEdit(editingRef.current.value, null);
                          scrollRef.current?.focus({ preventScroll: true });
                          const pos = { row: item.index, col };
                          setSelection((current) =>
                            event.shiftKey
                              ? { anchor: current.anchor, focus: pos }
                              : { anchor: pos, focus: pos },
                          );
                          setDragging(true);
                        }}
                        onDoubleClick={() => {
                          if (!isEditing) startEdit();
                        }}
                        className={clsx(
                          'relative flex min-w-0 items-center border-l border-border px-3 text-body',
                          column.align === 'end' && 'justify-end tabular',
                          column.readOnly === true ? 'bg-surface-alt text-text-muted' : 'text-text',
                          inBlock && !isFocus && 'bg-info-bg',
                          problem?.tone === 'danger' && 'bg-danger-bg',
                          isFocus && 'z-[1] shadow-[inset_0_0_0_2px_var(--b-primary)]',
                        )}
                      >
                        {isEditing ? (
                          <input
                            ref={inputRef}
                            autoFocus
                            aria-label={`${column.label} ${labels.row(item.index + 1)}`}
                            value={editing.value}
                            maxLength={column.maxLength}
                            inputMode={column.numeric === true ? 'numeric' : undefined}
                            onChange={(event) => {
                              setHighlight(0);
                              edit({ ...editing, value: event.target.value });
                            }}
                            onKeyDown={onEditKeyDown}
                            onBlur={() => endEdit(editingRef.current?.value ?? null, null)}
                            onPaste={(event) => {
                              // A block from a sheet goes into the cells, not into this one box.
                              const text = event.clipboardData.getData('text/plain');
                              if (!/[\t\n]/.test(text.replace(/\r?\n$/, ''))) return;
                              event.preventDefault();
                              endEdit(null, null);
                              paste(text);
                            }}
                            className={clsx(
                              'absolute inset-0 h-full w-full bg-surface px-3 text-body text-text outline-none shadow-[inset_0_0_0_2px_var(--b-primary)]',
                              column.align === 'end' && 'text-right tabular',
                            )}
                            data-testid={testId === undefined ? undefined : `${testId}.input`}
                          />
                        ) : placeholder !== undefined && placeholder !== '' ? (
                          <span className="truncate text-text-muted">{placeholder}</span>
                        ) : (
                          <span className="truncate">{value}</span>
                        )}
                        {problem === undefined || isEditing ? null : (
                          <span
                            aria-hidden
                            className={clsx(
                              'absolute right-0 top-0 size-0 border-l-[8px] border-t-[8px] border-l-transparent',
                              problem.tone === 'danger' ? 'border-t-danger' : 'border-t-warning',
                            )}
                          />
                        )}
                      </div>
                    );
                  })}
                  <div className="border-l border-border" aria-hidden />
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {menuAt === null || editing === null ? null : (
        <ul
          role="listbox"
          aria-label={editingColumn?.label}
          className="fixed z-50 max-h-64 overflow-y-auto rounded-sm border border-border bg-surface py-1 shadow-lg"
          style={{ left: menuAt.left, top: menuAt.top, minWidth: menuAt.width }}
          data-testid={testId === undefined ? undefined : `${testId}.suggestions`}
        >
          {suggestions.map((option, index) => (
            <li
              key={option}
              role="option"
              aria-selected={index === highlight}
              onMouseDown={(event) => {
                event.preventDefault();
                const value = takeSuggestion(
                  editing.value,
                  option,
                  editingColumn?.multiple === true,
                );
                if (editingColumn?.multiple === true) {
                  edit({ ...editing, value: `${value}, ` });
                  inputRef.current?.focus();
                } else {
                  endEdit(value, null);
                }
              }}
              onMouseEnter={() => setHighlight(index)}
              className={clsx(
                'cursor-pointer px-3 py-1.5 text-body text-text',
                index === highlight && 'bg-info-bg',
              )}
            >
              {option}
            </li>
          ))}
        </ul>
      )}
      <p
        role="status"
        aria-live="polite"
        className={clsx(
          'flex min-h-9 items-center gap-2 px-6 py-2 text-small',
          activeProblem?.tone === 'danger' || (activeProblem === undefined && activeRowProblem)
            ? 'text-danger'
            : activeProblem?.tone === 'warning'
              ? 'text-text'
              : 'text-text-muted',
        )}
        data-testid={testId === undefined ? undefined : `${testId}.status`}
      >
        {activeProblem !== undefined ? (
          <>
            <AlertCircle
              size={14}
              aria-hidden
              className={activeProblem.tone === 'danger' ? 'text-danger' : 'text-warning'}
            />
            <span>
              <span className="font-semibold">
                {labels.where(focus.row + 1, columns[focus.col]?.label ?? '')}
              </span>
              {': '}
              {activeProblem.message}
            </span>
          </>
        ) : activeRowProblem !== undefined ? (
          <>
            <AlertCircle size={14} aria-hidden />
            <span>
              <span className="font-semibold">{labels.row(focus.row + 1)}</span>
              {': '}
              {activeRowProblem}
            </span>
          </>
        ) : (
          hint
        )}
      </p>
    </div>
  );
}
