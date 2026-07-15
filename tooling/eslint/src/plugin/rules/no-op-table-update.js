// bolusi/no-op-table-update (08-stack-and-repo §5.2; op log is append-only — 05-operation-log §1, §2.3–2.4).
// Whole-repo rule. Fires on Kysely updateTable/deleteFrom targeting operation-log tables and
// on raw SQL strings mutating them.
//
// Two allowance shapes — column-level depth is REAL, not aspirational (a reviewer drove the
// gap where a file-level allowlist let a bookkeeping module UPDATE a signed-core column):
//
//   • `allowFiles` alone → FULL file exemption. For the append-only ENFORCEMENT files that
//     legitimately carry raw UPDATE/DELETE strings: the `CREATE TRIGGER ... BEFORE UPDATE ON
//     operations` DDL, and the adversarial append-only tests that attempt mutation to prove
//     it is refused.
//   • `allowFiles` + `allowColumns` → COLUMN-SCOPED. For core's single syncStatus bookkeeping
//     mutator (task 06) and the server acceptance path (task 07): `updateTable('operations')`
//     is permitted ONLY when its `.set({...})` keys are a statically-provable subset of
//     `allowColumns`. Any other key, a dynamic/spread `.set()` that cannot be proven a subset,
//     or a `deleteFrom` (DELETE is NEVER allowed, 05 §1) still errors — the signed core stays
//     immutable even in the one file sanctioned to touch the row.

const DEFAULT_OP_TABLES = ['operations'];
const RAW_SQL_MUTATION = /\b(update|delete\s+from)\b[\s\S]{0,200}?\boperations\b/i;

/**
 * True iff the `updateTable(...)` node is immediately `.set({...})` with a statically-known
 * object whose keys all lie within `allowed`. Fail-closed: a chained/dynamic/spread `.set()`
 * (or no immediate `.set()`) cannot be proven a subset, so it returns false and the caller errors.
 */
function setKeysWithinAllowance(updateNode, allowed) {
  const member = updateNode.parent;
  if (!member || member.type !== 'MemberExpression' || member.computed) return false;
  if (member.property.type !== 'Identifier' || member.property.name !== 'set') return false;
  const setCall = member.parent;
  if (!setCall || setCall.type !== 'CallExpression' || setCall.callee !== member) return false;
  const arg = setCall.arguments[0];
  if (!arg || arg.type !== 'ObjectExpression') return false;
  for (const prop of arg.properties) {
    // A SpreadElement or computed key cannot be proven a subset.
    if (prop.type !== 'Property' || prop.computed) return false;
    const key =
      prop.key.type === 'Identifier'
        ? prop.key.name
        : prop.key.type === 'Literal'
          ? String(prop.key.value)
          : null;
    if (key === null || !allowed.has(key)) return false;
  }
  return true;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Operation-log tables are append-only: no UPDATE/DELETE outside the allowlisted bookkeeping paths, and an allowlisted UPDATE may touch only its sanctioned bookkeeping columns (ai-docs/05-operation-log.md §1)',
    },
    messages: {
      opTableMutation:
        "Kysely {{method}}('{{table}}') targets an operation-log table — the signed core is immutable and DELETE is never allowed (05-operation-log §1, §2.3–2.4).",
      opTableColumnEscape:
        "updateTable('{{table}}') here may set ONLY the sanctioned bookkeeping columns ({{columns}}) — the signed core is immutable (05-operation-log §1, §2.3). A dynamic or spread .set() cannot be proven safe and is rejected.",
      rawSqlMutation:
        'Raw SQL appears to UPDATE/DELETE an operation-log table — the op log is append-only (05-operation-log §1).',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowFiles: { type: 'array', items: { type: 'string' } },
          allowColumns: { type: 'array', items: { type: 'string' } },
          opTables: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] ?? {};
    const allowFiles = options.allowFiles ?? [];
    const allowColumns = Array.isArray(options.allowColumns) ? new Set(options.allowColumns) : null;
    const opTables = new Set(options.opTables ?? DEFAULT_OP_TABLES);
    const filename = String(context.filename ?? '').replace(/\\/g, '/');
    const fileAllowed = allowFiles.some((suffix) => filename.endsWith(suffix));

    // Full file exemption ONLY without a column scope (DDL trigger / adversarial append-only
    // tests, which carry raw UPDATE/DELETE strings for legitimate reasons).
    if (fileAllowed && allowColumns === null) {
      return {};
    }

    const columnScoped = fileAllowed && allowColumns !== null;

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== 'MemberExpression' ||
          callee.computed ||
          callee.property.type !== 'Identifier' ||
          (callee.property.name !== 'updateTable' && callee.property.name !== 'deleteFrom')
        ) {
          return;
        }
        const arg = node.arguments[0];
        if (!(arg && arg.type === 'Literal' && typeof arg.value === 'string')) return;
        if (!opTables.has(arg.value)) return;

        const method = callee.property.name;

        // DELETE is NEVER allowed on the op log — not even in a column-scoped file (05 §1).
        if (method === 'deleteFrom') {
          context.report({
            node,
            messageId: 'opTableMutation',
            data: { method, table: arg.value },
          });
          return;
        }

        // updateTable: permitted in a column-scoped file only for a provable bookkeeping subset.
        if (columnScoped && setKeysWithinAllowance(node, allowColumns)) {
          return;
        }
        context.report({
          node,
          messageId: columnScoped ? 'opTableColumnEscape' : 'opTableMutation',
          data: {
            method,
            table: arg.value,
            columns: columnScoped ? [...allowColumns].join(', ') : '',
          },
        });
      },
      Literal(node) {
        if (typeof node.value === 'string' && RAW_SQL_MUTATION.test(node.value)) {
          context.report({ node, messageId: 'rawSqlMutation' });
        }
      },
      TemplateLiteral(node) {
        const text = node.quasis.map((q) => q.value.raw).join(' ');
        if (RAW_SQL_MUTATION.test(text)) {
          context.report({ node, messageId: 'rawSqlMutation' });
        }
      },
    };
  },
};
