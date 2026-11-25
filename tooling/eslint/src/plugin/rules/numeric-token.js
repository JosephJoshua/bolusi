// bolusi/numeric-token: phone styles get tabular figures from the `numeric` token (or show money
// with `Amount` / `AmountRow`), never a hand-written `fontVariant`, so every amount and count lines
// up the same way and one change to the token reaches every screen.

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'suggestion',
    docs: { description: 'Use the numeric token or Amount instead of a raw fontVariant' },
    messages: {
      raw: 'Spread `numeric` from @bolusi/ui (or show money with Amount) instead of setting fontVariant.',
    },
    schema: [],
  },
  create(context) {
    return {
      Property(node) {
        const key = node.key.type === 'Identifier' ? node.key.name : node.key.value;
        if (key === 'fontVariant') context.report({ node, messageId: 'raw' });
      },
    };
  },
};
