// The transparent at-rest encryption seam on the client Kysely (security-guide §6.4/§6.5; D22).
//
// This plugin does two things, and ONLY these:
//
//   WRITE (transformQuery): STRUCTURAL encryption of the encrypted columns that are written through
//     the Kysely QUERY BUILDER — `operations` (op-store) and `notes` (the module appliers). It walks
//     the INSERT/UPDATE node, and for a value bound to one of those (table, column) cells it replaces
//     the plaintext with ciphertext. This is what keeps a MODULE APPLIER UNAWARE (04 §2): the notes
//     applier writes `title`/`body` as plain strings and never learns they are sealed on disk.
//
//   READ (transformResult): TRANSPARENT decryption of EVERY result value that carries the cipher
//     marker, on every query (builder AND raw `sql`, `SELECT *` included). Decryption is by the value
//     itself (`isCiphertext`), never by column name — because raw `sql` and `SELECT *` hide which
//     column a value came from, and because a value the marker does not claim is passed through
//     untouched. So a plaintext column is never fed to `decrypt`, and a sealed value from ANY writer
//     (builder OR the raw-`sql` writers, which seal via `encryptColumnValue`) is opened here.
//
// ── WHY WRITES ARE SPLIT (structural here, registry there) ──────────────────────────────────────
// The raw-`sql` writers (pull `operations`, `user_pin_verifiers`, `users_directory`, `quarantined_ops`,
// `media_items`) are `<DB>`-generic and cannot express a typed builder INSERT (they have no client
// schema type — 08 §3.3), so their columns are opaque to an AST transform. They seal at the value via
// `encryptColumnValue(db, v)` (@bolusi/core) instead. Both paths use the SAME `ColumnCipher`, so the
// on-disk format is one format and THIS plugin's `transformResult` decrypts both. Reads are therefore
// uniform; only writes are split, along the exact line of "does the writer hold a typed table?".
//
// ── GRACEFUL DEGRADATION (why this doesn't break the test harnesses) ────────────────────────────
// A connection that does NOT install this plugin (a bare test Kysely) writes and reads plaintext, and
// `encryptColumnValue` on such a connection is a pass-through (its registry lookup misses). So a
// harness that never opted in behaves exactly as before this change — no harness edits were needed.
// The production connection (`openClientDb`) installs this plugin AND registers the cipher, so the two
// halves are always present together there.
import {
  ColumnNode,
  OperationNodeTransformer,
  PrimitiveValueListNode,
  TableNode,
  ValueListNode,
  ValueNode,
  ValuesNode,
  type ColumnUpdateNode,
  type InsertQueryNode,
  type UpdateQueryNode,
  type KyselyPlugin,
  type OperationNode,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryId,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
} from 'kysely';

import type { ColumnCipher } from '@bolusi/core';

/**
 * Encrypted columns written through the Kysely QUERY BUILDER, in snake_case (this plugin runs AFTER
 * `CamelCasePlugin`, so node identifiers are already snake_case). These are exactly the two
 * builder-written tables:
 *
 *   - `operations` — op-store's local-append INSERT (05 §1). The PULL insert of `operations` is raw
 *     `sql` and seals via the registry, not here.
 *   - `notes` — the module appliers' INSERT/UPDATE (04 §4).
 *
 * The other nine encrypted cells (user_pin_verifiers salt/hash/params, media_items.location,
 * quarantined_ops.signed_core_jcs, users_directory.name) are raw-`sql`-written and sealed at the
 * value via `encryptColumnValue`. This map is deliberately the BUILDER half only; the D22 addendum-2
 * set as a whole is enforced by the adversarial raw-file test, which drives every real writer.
 */
const BUILDER_ENCRYPTED_COLUMNS: Readonly<Record<string, ReadonlySet<string>>> = {
  operations: new Set(['payload', 'signed_core_jcs', 'location']),
  notes: new Set(['title', 'body']),
};

/**
 * Deep-clones the query tree, sealing the builder-written encrypted columns (see the map above).
 *
 * SCOPE, AND ITS TRAP: on an INSERT this seals `node.values` ONLY. An `INSERT … ON CONFLICT DO UPDATE
 * SET` or an `INSERT … SELECT` targeting `notes`/`operations` would therefore store the conflict-set
 * or projected values in the CLEAR — silently. No client code does either today (every `onConflict`
 * in the repo is `apps/server`, and the client's upserts are raw `sql`, which seals at the value via
 * `encryptColumnValue`), so this is a trap rather than a live bug. Anyone adding a builder upsert on
 * an encrypted table must extend this transformer to cover `onConflict`/`onDuplicateKey` — and prove
 * it with the raw-file probe, not by reading this comment.
 */
class ColumnEncryptTransformer extends OperationNodeTransformer {
  readonly #cipher: ColumnCipher;

  constructor(cipher: ColumnCipher) {
    super();
    this.#cipher = cipher;
  }

  protected override transformInsertQuery(
    node: InsertQueryNode,
    queryId?: QueryId,
  ): InsertQueryNode {
    const out = super.transformInsertQuery(node, queryId);
    const table = out.into?.table.identifier.name;
    if (table === undefined) return out;
    const columns = BUILDER_ENCRYPTED_COLUMNS[table];
    if (columns === undefined || out.columns === undefined || out.values === undefined) return out;

    const encryptAt = new Set<number>();
    out.columns.forEach((column, index) => {
      if (columns.has(column.column.name)) encryptAt.add(index);
    });
    if (encryptAt.size === 0 || !ValuesNode.is(out.values)) return out;

    const items = out.values.values.map((item) => this.#sealListItem(item, encryptAt));
    return { ...out, values: ValuesNode.create(items) };
  }

  protected override transformUpdateQuery(
    node: UpdateQueryNode,
    queryId?: QueryId,
  ): UpdateQueryNode {
    const out = super.transformUpdateQuery(node, queryId);
    const table =
      out.table !== undefined && TableNode.is(out.table)
        ? out.table.table.identifier.name
        : undefined;
    if (table === undefined) return out;
    const columns = BUILDER_ENCRYPTED_COLUMNS[table];
    if (columns === undefined || out.updates === undefined) return out;

    const updates = out.updates.map((update) => this.#sealUpdate(update, columns));
    return { ...out, updates };
  }

  #sealListItem(
    item: PrimitiveValueListNode | ValueListNode,
    encryptAt: ReadonlySet<number>,
  ): PrimitiveValueListNode | ValueListNode {
    if (PrimitiveValueListNode.is(item)) {
      const values = item.values.map((value, index) =>
        encryptAt.has(index) ? this.#sealPrimitive(value) : value,
      );
      return PrimitiveValueListNode.create(values);
    }
    const values = item.values.map((value, index) =>
      encryptAt.has(index) ? this.#sealValueNode(value) : value,
    );
    return ValueListNode.create(values);
  }

  #sealUpdate(update: ColumnUpdateNode, columns: ReadonlySet<string>): ColumnUpdateNode {
    if (!ColumnNode.is(update.column) || !columns.has(update.column.column.name)) return update;
    return { ...update, value: this.#sealValueNode(update.value) };
  }

  /** A sealed replacement for a `ValueNode` string; anything else (an expression, a number) is left. */
  #sealValueNode(node: OperationNode): OperationNode {
    if (ValueNode.is(node) && typeof node.value === 'string') {
      return ValueNode.create(this.#cipher.encrypt(node.value));
    }
    return node;
  }

  /** Seal a raw primitive (the `PrimitiveValueListNode` case). Non-strings (null, numbers) pass through. */
  #sealPrimitive(value: unknown): unknown {
    return typeof value === 'string' ? this.#cipher.encrypt(value) : value;
  }
}

/** Decrypt every marker-bearing value in a result row; rows with no ciphertext are returned as-is. */
function decryptRow(cipher: ColumnCipher, row: UnknownRow): UnknownRow {
  let out: Record<string, unknown> | undefined;
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (cipher.isCiphertext(value)) {
      (out ??= { ...row })[key] = cipher.decrypt(value);
    }
  }
  return out ?? row;
}

/**
 * Build the client's column-encryption plugin. Install it AFTER `CamelCasePlugin` so this plugin sees
 * snake_case identifiers on the way in; `transformResult` runs before `CamelCasePlugin`'s (plugins
 * result-transform in reverse), but that is immaterial — decryption keys off the VALUE, not the key.
 */
export function createColumnEncryptionPlugin(cipher: ColumnCipher): KyselyPlugin {
  const transformer = new ColumnEncryptTransformer(cipher);
  return {
    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
      return transformer.transformNode(args.node, args.queryId);
    },
    transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
      const rows = args.result.rows.map((row) => decryptRow(cipher, row));
      return Promise.resolve({ ...args.result, rows });
    },
  };
}
