// bolusi/no-op-table-update (08-stack-and-repo §5.2; op log is append-only — 05-operation-log §1, §2.3–2.4).
// Whole-repo rule. Fires on Kysely updateTable/deleteFrom targeting operation-log tables and
// on raw SQL strings mutating them. The `allowFiles` option is the exact-file allowlist for
// core's bookkeeping modules / the server acceptance path (column-level depth: tasks 06/07).

const DEFAULT_OP_TABLES = ['operations'];
const RAW_SQL_MUTATION = /\b(update|delete\s+from)\b[\s\S]{0,200}?\boperations\b/i;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Operation-log tables are append-only: no UPDATE/DELETE outside the allowlisted bookkeeping paths (ai-docs/05-operation-log.md §1)',
    },
    messages: {
      opTableMutation:
        "Kysely {{method}}('{{table}}') targets an operation-log table — the signed core is immutable and DELETE is never allowed (05-operation-log §1, §2.3–2.4).",
      rawSqlMutation:
        'Raw SQL appears to UPDATE/DELETE an operation-log table — the op log is append-only (05-operation-log §1).',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowFiles: { type: 'array', items: { type: 'string' } },
          opTables: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] ?? {};
    const allowFiles = options.allowFiles ?? [];
    const opTables = new Set(options.opTables ?? DEFAULT_OP_TABLES);
    const filename = String(context.filename ?? '').replace(/\\/g, '/');
    if (allowFiles.some((suffix) => filename.endsWith(suffix))) {
      return {};
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          (callee.property.name === 'updateTable' || callee.property.name === 'deleteFrom')
        ) {
          const arg = node.arguments[0];
          if (arg && arg.type === 'Literal' && typeof arg.value === 'string') {
            if (opTables.has(arg.value)) {
              context.report({
                node,
                messageId: 'opTableMutation',
                data: { method: callee.property.name, table: arg.value },
              });
            }
          }
        }
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
