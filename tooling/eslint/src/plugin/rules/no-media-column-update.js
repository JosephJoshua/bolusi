// bolusi/no-media-column-update — media metadata is frozen at capture (06-media-pipeline §4:
// "**no UPDATE path exists** for these columns"; §3.2; FR-816/FR-817/FR-819/FR-1142/FR-1143).
// Same mechanism class as bolusi/no-op-table-update (05-operation-log §1), deliberately.
//
// WHY THIS BANS COLUMNS, NOT FILES — the shape differs from no-op-table-update on purpose.
// That rule exempts FILES (an allowlisted file may UPDATE `operations`, restricted to bookkeeping
// columns). This one has NO allowlist and no exempt file, because the split is cleaner here:
// `media_items` has eight columns that must never change and eleven that legitimately do
// (upload_status, upload_attempts, next_attempt_at, last_error_*, uploaded_at, chunk_size,
// chunks_total, local_path, attached_to_operation_id). So the rule can name the eight and let
// every writer through on the rest — no file needs an exemption, and there is nothing to erode.
// A file-level allowlist would have been strictly worse: it is the exact shape a reviewer already
// drove a hole through on the op-log rule ("a file-level allowlist let a bookkeeping module UPDATE
// a signed-core column"), and it would have to grow an entry for every future media writer.
//
// WHAT THE COLUMNS ARE BOUND TO, i.e. why this is a security rule and not hygiene: the referencing
// operation's payload carries a `mediaRef` whose `sha256`/`capturedAt`/`location`/`userId`/
// `deviceId` are covered by an Ed25519 signature and a hash chain (06 §3.1; 05 §2–§4). Rewriting
// the row does not merely desync a cache — it makes the local row disagree with a signed claim
// about what evidence was captured, where, by whom. FR-819's correction path is a NEW media id on
// a NEW operation with a reason, never a mutation.
//
// COVERS BOTH PRONGS, and the raw-SQL one is the load-bearing half here: the client media
// repository is written in raw `sql` templates, so a Kysely-only rule (the shape `opTables` would
// have given us — its RAW_SQL_MUTATION regex hardcodes `operations`) would inspect zero of the
// lines that actually write this table. A guard that checks nothing is worse than none
// (CLAUDE.md §2.11).

/** 06 §4 + §3.2's frozen-at-capture set, in both spellings (raw SQL snake_case; Kysely camelCase). */
const IMMUTABLE_COLUMNS = [
  'captured_at',
  'location',
  'captured_by_user_id',
  'device_id',
  'type',
  'mime_type',
  'byte_size',
  'sha256',
];

const IMMUTABLE_CAMEL = new Set([
  'capturedAt',
  'location',
  'capturedByUserId',
  'deviceId',
  'type',
  'mimeType',
  'byteSize',
  'sha256',
]);

const IMMUTABLE_SNAKE = new Set(IMMUTABLE_COLUMNS);

const MEDIA_TABLES = new Set(['media_items', 'mediaItems']);

/**
 * Unwrap TS type-assertion wrappers so `.set({ uploadStatus: 'x' } as never)` is still seen as the
 * object literal it is.
 *
 * Without this the rule fails closed on a extremely common idiom and reports `immutableColumnDynamic`
 * for provably-safe bookkeeping writes. That is not a harmless false positive: a rule that cries
 * wolf on correct code gets silenced with an `eslint-disable`, and the disable comment then covers
 * the frozen columns too. Precision here is what keeps the rule enforceable.
 */
function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSTypeAssertion')
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Does this raw SQL text UPDATE media_items and assign an immutable column?
 *
 * Two-stage on purpose. A single mega-regex over `UPDATE ... SET ... col` breaks on multi-line DDL
 * and on column names that appear in a WHERE clause: `UPDATE media_items SET upload_status = 'x'
 * WHERE sha256 = ?` is LEGAL (sha256 is being read, not written) and a naive
 * /update[\s\S]*media_items[\s\S]*sha256/ would flag it. So: find the UPDATE...SET on media_items,
 * then inspect only the assignment list that follows, up to a clause keyword that ends it.
 */
function rawSqlViolation(text) {
  const update = /\bupdate\s+(?:"|`|\[)?media_items(?:"|`|\])?\s+set\b/i.exec(text);
  if (update === null) return null;
  const after = text.slice(update.index + update[0].length);
  // The SET list ends at WHERE / RETURNING / a statement end. Everything before that is assignments.
  const setList = after.split(/\bwhere\b|\breturning\b|;/i)[0] ?? after;
  for (const column of IMMUTABLE_COLUMNS) {
    // `col =` or `"col" =` as an assignment target within the SET list.
    const assign = new RegExp(`(?:^|[,\\s(])(?:"|\`|\\[)?${column}(?:"|\`|\\])?\\s*=`, 'i');
    if (assign.test(setList)) return column;
  }
  return null;
}

/** DELETE FROM media_items — only ever legitimate for orphan cleanup (06 §4/§7), which is why it
 * is NOT banned here. Recorded so the next reader does not add it thinking it was forgotten:
 * 06 §7's orphan rule requires "file + row deleted 24 h after capturedAt", and §7's retention rule
 * requires the row to SURVIVE ("the record is the index into server media"). Only a human can tell
 * those apart, so the pruning pass owns the distinction and `prunePlanFor` is where it is tested. */

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'media_items metadata is frozen at capture: no UPDATE may assign captured_at, location, captured_by_user_id, device_id, type, mime_type, byte_size or sha256 (ai-docs/06-media-pipeline.md §4)',
    },
    messages: {
      immutableColumn:
        "UPDATE on media_items may not assign '{{column}}' — media metadata is frozen at capture and is covered by the referencing operation's signature (06-media-pipeline §4, §3.2; FR-817). Correction is a NEW media id on a NEW operation (FR-819), never a mutation.",
      immutableColumnDynamic:
        "updateTable('media_items') here uses a dynamic or spread .set() that cannot be proven free of the frozen columns ({{columns}}) — 06-media-pipeline §4 says no UPDATE path exists for them, so this fails closed. Name the bookkeeping columns explicitly.",
      rawSqlImmutableColumn:
        "Raw SQL UPDATEs media_items and assigns '{{column}}' — media metadata is frozen at capture (06-media-pipeline §4; FR-817).",
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowFiles: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] ?? {};
    const allowFiles = options.allowFiles ?? [];
    const filename = String(context.filename ?? '').replace(/\\/g, '/');
    // The ONLY sanctioned exemption class: adversarial tests that deliberately attempt the
    // mutation in order to prove it is refused, and which therefore must contain the pattern.
    if (allowFiles.some((suffix) => filename.endsWith(suffix))) return {};

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== 'MemberExpression' ||
          callee.computed ||
          callee.property.type !== 'Identifier' ||
          callee.property.name !== 'updateTable'
        ) {
          return;
        }
        const arg = node.arguments[0];
        if (!(arg && arg.type === 'Literal' && typeof arg.value === 'string')) return;
        if (!MEDIA_TABLES.has(arg.value)) return;

        // Find the immediately-chained `.set({...})`.
        const member = node.parent;
        if (!member || member.type !== 'MemberExpression' || member.computed) return;
        if (member.property.type !== 'Identifier' || member.property.name !== 'set') return;
        const setCall = member.parent;
        if (!setCall || setCall.type !== 'CallExpression' || setCall.callee !== member) return;
        const objectArg = unwrapExpression(setCall.arguments[0]);

        // A dynamic `.set(patch)` cannot be proven free of the frozen columns → fail closed.
        if (!objectArg || objectArg.type !== 'ObjectExpression') {
          context.report({
            node,
            messageId: 'immutableColumnDynamic',
            data: { columns: [...IMMUTABLE_CAMEL].join(', ') },
          });
          return;
        }
        for (const prop of objectArg.properties) {
          if (prop.type !== 'Property') {
            // A spread cannot be proven a safe subset → fail closed (same posture as the op rule).
            context.report({
              node: prop,
              messageId: 'immutableColumnDynamic',
              data: { columns: [...IMMUTABLE_CAMEL].join(', ') },
            });
            return;
          }
          if (prop.computed) {
            context.report({
              node: prop,
              messageId: 'immutableColumnDynamic',
              data: { columns: [...IMMUTABLE_CAMEL].join(', ') },
            });
            return;
          }
          const key =
            prop.key.type === 'Identifier'
              ? prop.key.name
              : prop.key.type === 'Literal'
                ? String(prop.key.value)
                : null;
          if (key === null) continue;
          if (IMMUTABLE_CAMEL.has(key) || IMMUTABLE_SNAKE.has(key)) {
            context.report({ node: prop, messageId: 'immutableColumn', data: { column: key } });
          }
        }
      },
      Literal(node) {
        if (typeof node.value !== 'string') return;
        const column = rawSqlViolation(node.value);
        if (column !== null) {
          context.report({ node, messageId: 'rawSqlImmutableColumn', data: { column } });
        }
      },
      TemplateLiteral(node) {
        // Join with a space so an interpolation cannot glue two tokens into a false negative.
        const text = node.quasis.map((q) => q.value.raw).join(' ');
        const column = rawSqlViolation(text);
        if (column !== null) {
          context.report({ node, messageId: 'rawSqlImmutableColumn', data: { column } });
        }
      },
    };
  },
};
