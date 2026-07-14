// bolusi/no-float-money (08-stack-and-repo §5.2; money is integer IDR — 05-operation-log §3).
// Scope (set by the shared config): packages/schemas + packages/modules.
// Fires on: z.number() chains missing .int(), parseFloat/Number.parseFloat/toFixed on
// money-named identifiers, and non-integer numeric literals.

const MONEY_NAME = /(amount|price|cost|total|fee|idr)/i;

/** Walk a method chain upwards from a call and collect chained method names. */
function chainHasInt(zNumberCall) {
  let current = zNumberCall;
  while (
    current.parent &&
    current.parent.type === 'MemberExpression' &&
    current.parent.object === current &&
    !current.parent.computed &&
    current.parent.parent &&
    current.parent.parent.type === 'CallExpression' &&
    current.parent.parent.callee === current.parent
  ) {
    if (current.parent.property.type === 'Identifier' && current.parent.property.name === 'int') {
      return true;
    }
    current = current.parent.parent;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Money is integer IDR — z.number() must chain .int(); float operations on money identifiers are forbidden (ai-docs/05-operation-log.md §3)',
    },
    messages: {
      zNumberWithoutInt:
        'z.number() without .int() in a schema file — money and counts are integers (05-operation-log §3). Chain .int() or use a non-numeric type.',
      floatOnMoney:
        "Float operation on money-named identifier '{{name}}' — money is integer IDR, floats never (05-operation-log §3).",
      nonIntegerLiteral:
        'Non-integer numeric literal in a schema file — money is integer IDR (05-operation-log §3).',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        // z.number() without a chained .int()
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'z' &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'number'
        ) {
          if (!chainHasInt(node)) {
            context.report({ node, messageId: 'zNumberWithoutInt' });
          }
        }
        // parseFloat(amount) / Number.parseFloat(amount)
        const isParseFloat =
          (callee.type === 'Identifier' && callee.name === 'parseFloat') ||
          (callee.type === 'MemberExpression' &&
            !callee.computed &&
            callee.object.type === 'Identifier' &&
            callee.object.name === 'Number' &&
            callee.property.type === 'Identifier' &&
            callee.property.name === 'parseFloat');
        if (isParseFloat) {
          for (const arg of node.arguments) {
            if (arg.type === 'Identifier' && MONEY_NAME.test(arg.name)) {
              context.report({ node, messageId: 'floatOnMoney', data: { name: arg.name } });
            }
          }
        }
        // amount.toFixed(2)
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'toFixed' &&
          callee.object.type === 'Identifier' &&
          MONEY_NAME.test(callee.object.name)
        ) {
          context.report({ node, messageId: 'floatOnMoney', data: { name: callee.object.name } });
        }
      },
      Literal(node) {
        if (typeof node.value === 'number' && !Number.isInteger(node.value)) {
          context.report({ node, messageId: 'nonIntegerLiteral' });
        }
      },
    };
  },
};
