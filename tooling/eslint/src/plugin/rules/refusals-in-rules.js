// A named refusal is a verdict on the records, so it belongs to the op's rule: the device runs that
// rule before saving and the server runs it before accepting a push. A command that refuses on its
// own is a check the server never makes, so a modified or offline phone gets past it. Commands call
// a check exported from rules.ts, or `refuseOnDevice` for a reason declared device-only.
const REFUSALS_OBJECT = /_REFUSALS$/;

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Commands refuse through the op rules, which the server runs too.' },
    schema: [],
    messages: {
      commandRefusal:
        'A command that refuses on its own is a check the server never makes. Put the check in the op rule (rules.ts) and, to refuse early, call a check exported from rules.ts. Only for a check the server cannot judge, declare the reason device-only in defineRefusals and use refuseOnDevice.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.name === 'refuse' &&
          callee.object.type === 'Identifier' &&
          REFUSALS_OBJECT.test(callee.object.name)
        ) {
          context.report({ node, messageId: 'commandRefusal' });
        }
      },
      VariableDeclarator(node) {
        if (
          node.id.type === 'ObjectPattern' &&
          node.init?.type === 'Identifier' &&
          REFUSALS_OBJECT.test(node.init.name) &&
          node.id.properties.some(
            (p) => p.type === 'Property' && p.key.type === 'Identifier' && p.key.name === 'refuse',
          )
        ) {
          context.report({ node, messageId: 'commandRefusal' });
        }
      },
    };
  },
};
