// bolusi/no-row-divider: a phone screen never draws a line under its own rows. A row's bottom border
// shows under the last row too, where the list ends, so the line belongs to the list: `Rows` and
// `List` (packages/ui) draw one between rows only, and `ReorderableList` does it for dragged rows.

const NAMES = new Set(['borderBottomWidth']);

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'No bottom borders in phone screens: put rows in Rows or List for dividers',
    },
    messages: {
      divider:
        "'{{name}}' leaves a line under the last row. Put the rows in `Rows` or `List`, which draw dividers between rows only.",
    },
    schema: [],
  },
  create(context) {
    return {
      Property(node) {
        const name =
          node.key.type === 'Identifier'
            ? node.key.name
            : node.key.type === 'Literal'
              ? String(node.key.value)
              : null;
        if (name !== null && !node.computed && NAMES.has(name)) {
          context.report({ node, messageId: 'divider', data: { name } });
        }
      },
    };
  },
};
