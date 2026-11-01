// Least-privilege sync: a device holds only what its people may read, and a signed-in person's
// extra comes down only while online. A query reading a table whose data is not here would answer
// from an empty copy ("Rp 0", a servisan number counted again). Nothing declares what a query
// reads: every statement a handler runs is checked against the read of each table it touches (the
// op types folding into that table share one, `projectionTableReads`), so a new module's queries
// are covered with nothing to remember.
import type {
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  RootOperationNode,
  UnknownRow,
} from 'kysely';

/** A handler touched a table whose read is not on this device right now. */
export class ReadNotHereError extends Error {
  override readonly name = 'ReadNotHereError';
  constructor(
    readonly table: string,
    readonly read: string,
  ) {
    super(`${table} is read with ${read}, which this device does not hold right now`);
  }
}

/**
 * A query handler named a table inside raw SQL, where the check cannot see it. Build the
 * subquery with Kysely instead (an `expressionBuilder()` subquery is still one expression).
 */
export class RawTableReadError extends Error {
  override readonly name = 'RawTableReadError';
  constructor(fragment: string) {
    super(
      `a query read a table through raw SQL (${fragment.trim().slice(0, 60)}…): build it with Kysely so the device can tell whether its data is here (core query/reads-here.ts)`,
    );
  }
}

// FROM or JOIN in a raw fragment is a table read the tree does not show.
const RAW_TABLE_READ = /\b(from|join)\b/i;

/** Every table a statement's tree names, joins and subqueries included. */
function tablesOf(node: unknown, found: Set<string>): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) tablesOf(item, found);
  } else if (typeof node === 'object' && node !== null) {
    const record = node as {
      kind?: unknown;
      table?: { identifier?: { name?: unknown } };
      sqlFragments?: unknown;
    };
    if (record.kind === 'TableNode' && typeof record.table?.identifier?.name === 'string') {
      found.add(record.table.identifier.name);
    }
    if (record.kind === 'RawNode' && Array.isArray(record.sqlFragments)) {
      const raw = record.sqlFragments.join(' ');
      if (RAW_TABLE_READ.test(raw)) throw new RawTableReadError(raw);
    }
    for (const value of Object.values(node)) tablesOf(value, found);
  }
  return found;
}

/** Stops, before it runs, a statement touching a table whose read is not here. */
export class ReadsHerePlugin implements KyselyPlugin {
  readonly #tableReads: ReadonlyMap<string, string | null>;
  readonly #readHere: (permissionId: string) => boolean;

  constructor(
    tableReads: ReadonlyMap<string, string | null>,
    readHere: (permissionId: string) => boolean,
  ) {
    this.#tableReads = tableReads;
    this.#readHere = readHere;
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    for (const table of tablesOf(args.node, new Set())) {
      const read = this.#tableReads.get(table);
      if (typeof read === 'string' && !this.#readHere(read))
        throw new ReadNotHereError(table, read);
    }
    return args.node;
  }

  transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return Promise.resolve(args.result);
  }
}
