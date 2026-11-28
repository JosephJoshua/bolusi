// bolusi/single-choice-control: a ToggleChip is a checkbox, picked on and off by itself. Chips whose
// `selected` compares one value (`selected={method === row.id}`) answer one question together: that is
// a radio group, which `SegmentedControl` draws across the full width with every answer in view. A
// row of such chips sized to their labels left half the screen empty and announced the wrong role.
// A chip that clears its value when tapped again (`x === v ? '' : v`, a quick pick filling a field or
// a filter) stays a ToggleChip: its onToggle carries that conditional.

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'One answer of a set is a SegmentedControl, not ToggleChips' },
    messages: {
      radio:
        'These chips pick one value of a set: use `SegmentedControl` (one answer, full width), or clear the value when the picked chip is tapped again.',
    },
    schema: [],
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'ToggleChip') return;
        const attr = (name) =>
          node.attributes.find((a) => a.type === 'JSXAttribute' && a.name.name === name);
        const selected = attr('selected');
        const expr =
          selected?.value?.type === 'JSXExpressionContainer' ? selected.value.expression : null;
        if (expr?.type !== 'BinaryExpression' || expr.operator !== '===') return;
        const toggle = attr('onToggle');
        const source = toggle === undefined ? '' : context.sourceCode.getText(toggle);
        if (/\?/.test(source)) return;
        context.report({ node, messageId: 'radio' });
      },
    };
  },
};
