// The spreadsheet grid's pure parts: reading and writing the clipboard the way Excel and Google
// Sheets do, the selected block, and what a paste does to the rows. Kept apart from the React
// component so each rule is tested on its own.

/** One row of the grid: a stable id and its cells' text by column id. */
export interface GridRow {
  readonly id: string;
  readonly cells: Readonly<Record<string, string>>;
}

export interface CellPos {
  readonly row: number;
  readonly col: number;
}

/** A block of cells: where the selection started and where it reaches now. */
export interface CellRange {
  readonly anchor: CellPos;
  readonly focus: CellPos;
}

export interface Bounds {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

export function boundsOf(range: CellRange): Bounds {
  return {
    top: Math.min(range.anchor.row, range.focus.row),
    left: Math.min(range.anchor.col, range.focus.col),
    bottom: Math.max(range.anchor.row, range.focus.row),
    right: Math.max(range.anchor.col, range.focus.col),
  };
}

export function inBounds(bounds: Bounds, row: number, col: number): boolean {
  return row >= bounds.top && row <= bounds.bottom && col >= bounds.left && col <= bounds.right;
}

/**
 * Cells as Excel and Google Sheets put them on the clipboard: tabs between cells, a line per row,
 * and a cell holding a tab, line break or quote wrapped in quotes with its quotes doubled. The
 * line break after the last row is not an extra empty row.
 */
export function parseClipboardTable(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let atCellStart = true;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && atCellStart) {
      quoted = true;
      atCellStart = false;
      continue;
    }
    if (ch === '\t') {
      row.push(cell);
      cell = '';
      atCellStart = true;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      atCellStart = true;
      continue;
    }
    cell += ch;
    atCellStart = false;
  }
  if (!atCellStart || cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Cells for the clipboard, so a copied block pastes back into Excel cell for cell. */
export function toClipboardTable(rows: readonly (readonly string[])[]): string {
  const quote = (cell: string): string =>
    /[\t\r\n"]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
  return rows.map((row) => row.map(quote).join('\t')).join('\n');
}

/** Whether a row has anything typed in it. */
export function rowFilled(row: GridRow): boolean {
  return Object.values(row.cells).some((value) => value.trim() !== '');
}

export interface PasteColumn {
  readonly id: string;
  readonly label: string;
  /** Other headings that mean this column, such as "Nama barang" for "Nama". */
  readonly aliases?: readonly string[] | undefined;
  /** A column that is shown but never typed into. */
  readonly readOnly?: boolean | undefined;
}

const headingKey = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * When the block's first line is a heading row (every filled cell names a column, and at least two
 * do), which column each pasted column goes to; otherwise null. That lets a sheet with its columns
 * in another order, or with extra columns, paste straight in.
 */
export function headingMap(
  block: readonly (readonly string[])[],
  columns: readonly PasteColumn[],
): (string | null)[] | null {
  const first = block[0];
  if (first === undefined || block.length < 2) return null;
  const byHeading = new Map<string, string>();
  for (const column of columns) {
    if (column.readOnly === true) continue;
    for (const heading of [column.label, ...(column.aliases ?? [])]) {
      const key = headingKey(heading);
      if (key !== '' && !byHeading.has(key)) byHeading.set(key, column.id);
    }
  }
  const map = first.map((cell) => byHeading.get(headingKey(cell)) ?? null);
  const filled = first.filter((cell) => cell.trim() !== '').length;
  const named = map.filter((id) => id !== null).length;
  if (named < 2 || named < filled) return null;
  return map;
}

export interface PasteResult {
  readonly rows: readonly GridRow[];
  /** The block the paste filled, to select afterwards. */
  readonly range: CellRange;
}

/**
 * Put a pasted block into the rows. A heading row maps the block's columns by name, from the first
 * column; otherwise the block lands with its top left on the selection's top left. One value
 * pasted over a selected block fills the whole block, as in Excel. Rows are added as needed;
 * columns past the last one, and read-only columns, are left alone.
 */
export function pasteBlock({
  rows,
  columns,
  selection,
  block,
  newRow,
}: {
  readonly rows: readonly GridRow[];
  readonly columns: readonly PasteColumn[];
  readonly selection: CellRange;
  readonly block: readonly (readonly string[])[];
  readonly newRow: () => GridRow;
}): PasteResult | null {
  if (block.length === 0 || columns.length === 0) return null;
  const bounds = boundsOf(selection);
  const next = [...rows];
  const setCell = (rowIndex: number, columnId: string, value: string): void => {
    while (next.length <= rowIndex) next.push(newRow());
    const row = next[rowIndex]!;
    next[rowIndex] = { ...row, cells: { ...row.cells, [columnId]: value } };
  };
  const writable = (index: number): PasteColumn | null => {
    const column = columns[index];
    return column === undefined || column.readOnly === true ? null : column;
  };

  const headings = headingMap(block, columns);
  if (headings !== null) {
    const body = block.slice(1);
    body.forEach((line, offset) =>
      line.forEach((value, index) => {
        const id = headings[index];
        if (id !== null && id !== undefined) setCell(bounds.top + offset, id, value.trim());
      }),
    );
    const used = headings
      .map((id) => columns.findIndex((column) => column.id === id))
      .filter((i) => i >= 0);
    return {
      rows: next,
      range: {
        anchor: { row: bounds.top, col: Math.min(...used) },
        focus: { row: bounds.top + body.length - 1, col: Math.max(...used) },
      },
    };
  }

  const single = block.length === 1 && block[0]!.length === 1;
  if (single && (bounds.bottom > bounds.top || bounds.right > bounds.left)) {
    const value = block[0]![0]!;
    for (let r = bounds.top; r <= bounds.bottom; r += 1) {
      for (let c = bounds.left; c <= bounds.right; c += 1) {
        const column = writable(c);
        if (column !== null) setCell(r, column.id, value);
      }
    }
    return { rows: next, range: selection };
  }

  const width = Math.max(...block.map((line) => line.length));
  block.forEach((line, offset) =>
    line.forEach((value, index) => {
      const column = writable(bounds.left + index);
      if (column !== null) setCell(bounds.top + offset, column.id, value);
    }),
  );
  return {
    rows: next,
    range: {
      anchor: { row: bounds.top, col: bounds.left },
      focus: {
        row: bounds.top + block.length - 1,
        col: Math.min(columns.length - 1, bounds.left + width - 1),
      },
    },
  };
}

/** The selected block's text, row by row, for the clipboard. */
export function copyBlock(
  rows: readonly GridRow[],
  columns: readonly PasteColumn[],
  bounds: Bounds,
  shown: (row: GridRow, columnId: string) => string = (row, id) => row.cells[id] ?? '',
): string[][] {
  const out: string[][] = [];
  for (let r = bounds.top; r <= Math.min(bounds.bottom, rows.length - 1); r += 1) {
    const line: string[] = [];
    for (let c = bounds.left; c <= bounds.right; c += 1) {
      const column = columns[c];
      line.push(column === undefined ? '' : shown(rows[r]!, column.id));
    }
    out.push(line);
  }
  return out;
}

/** The rows with the block's cells emptied. */
export function clearBlock(
  rows: readonly GridRow[],
  columns: readonly PasteColumn[],
  bounds: Bounds,
): GridRow[] {
  return rows.map((row, index) => {
    if (index < bounds.top || index > bounds.bottom) return row;
    const cells = { ...row.cells };
    for (let c = bounds.left; c <= bounds.right; c += 1) {
      const column = columns[c];
      if (column !== undefined && column.readOnly !== true) cells[column.id] = '';
    }
    return { ...row, cells };
  });
}

/**
 * The rows with one empty row kept at the end to type into, like a sheet's next line, and any other
 * empty rows at the end dropped.
 */
export function withTrailingRow(rows: readonly GridRow[], newRow: () => GridRow): GridRow[] {
  let end = rows.length;
  while (end > 0 && !rowFilled(rows[end - 1]!)) end -= 1;
  const kept = rows.slice(0, end);
  const spare = rows[end];
  return [...kept, spare ?? newRow()];
}
