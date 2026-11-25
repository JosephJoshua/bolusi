// bolusi/no-cut-text: text on the PC never cuts itself off with a CSS class. Labels wrap or the
// layout changes (design guide §9). A long value someone typed, shown in a table cell or list row,
// goes through `OverflowText`, which cuts it and shows the whole value in a tooltip. On the phone
// the same rule is a type: `Text` has no `numberOfLines`, only `ValueText` does.

const CUTS = /(?:^|\s)(?:[\w:@[\]-]*:)?(truncate|line-clamp-\d+|text-ellipsis)(?=\s|$)/;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'No truncate or line-clamp classes: wrap labels, use OverflowText for typed values',
    },
    messages: {
      cut: "'{{name}}' cuts text off. Let a label wrap; show a long typed value with OverflowText.",
    },
    schema: [],
  },
  create(context) {
    const check = (node, value) => {
      const match = CUTS.exec(value);
      if (match !== null) context.report({ node, messageId: 'cut', data: { name: match[1] } });
    };
    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? '');
      },
    };
  },
};
