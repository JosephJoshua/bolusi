// bolusi/no-token-literals — design-system §7 lint (a): color/size literals in `.tsx` are errors
// outside `tokens.ts`. Tokens are the ONLY styling vocabulary (design-system §1); a raw hex or a
// raw dp value at a call site is exactly how a palette-closed / scale-closed system stops being
// closed.
//
// Scope (set by the shared config, matching design-system §7): packages/ui, apps/mobile,
// packages/modules/**/screens. `tokens.ts` is the single exempt file — it IS the vocabulary.
//
// WHAT COUNTS AS A VIOLATION:
//   1. A hex colour string literal anywhere (`'#1D4ED8'`) — colours have exactly one home.
//   2. A numeric literal used as a STYLE VALUE — i.e. the value of a property inside an object that
//      is itself a style. We detect "style context" structurally (StyleSheet.create({...}) or a
//      `style={{...}}` JSX prop) rather than by property-name guessing, so `windowSize={7}` or
//      `numberOfLines={2}` (legitimate non-style numbers) never trip it.
//
// DELIBERATELY NOT FLAGGED: 0 and 1 (flex, opacity extremes, and StyleSheet.hairlineWidth-style
// unit values are unavoidable and carry no palette/scale meaning); percentage/string dimensions
// like '100%'. The rule targets the values that belong to the closed token scales.

const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Numbers that carry no scale meaning and are noise to flag. */
const ALLOWED_NUMBERS = new Set([0, 1]);

/**
 * Is `node` (an object expression) a style object — either an argument to `StyleSheet.create`, or
 * the expression of a `style={{...}}` JSX attribute, or nested inside one?
 */
function isInStyleContext(node) {
  let current = node.parent;
  let child = node;
  while (current) {
    // StyleSheet.create({ ... })
    if (
      current.type === 'CallExpression' &&
      current.callee.type === 'MemberExpression' &&
      current.callee.object.type === 'Identifier' &&
      current.callee.object.name === 'StyleSheet' &&
      current.callee.property.type === 'Identifier' &&
      current.callee.property.name === 'create'
    ) {
      return true;
    }
    // style={{ ... }}  (JSXExpressionContainer whose attribute is `style`)
    if (
      current.type === 'JSXExpressionContainer' &&
      current.parent &&
      current.parent.type === 'JSXAttribute' &&
      current.parent.name.type === 'JSXIdentifier' &&
      current.parent.name.name === 'style'
    ) {
      return true;
    }
    // Don't cross out of the object/array graph into arbitrary expressions.
    if (
      current.type !== 'ObjectExpression' &&
      current.type !== 'Property' &&
      current.type !== 'ArrayExpression' &&
      current.type !== 'JSXExpressionContainer'
    ) {
      return false;
    }
    child = current;
    current = current.parent;
    void child;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'No raw color/size literals outside tokens.ts — tokens are the only styling vocabulary (ai-docs/design-system.md §1, §7).',
    },
    messages: {
      hex: "Raw color literal '{{value}}'. Use a token from @bolusi/ui tokens.ts (design-system §1.1).",
      size: 'Raw size literal {{value}} in a style. Use a spacing/radius/touch/size token (design-system §1.3–1.4, §7).',
    },
    schema: [],
  },
  create(context) {
    return {
      Literal(node) {
        // Hex colour, anywhere (colours never have a legitimate non-token home in these files).
        if (typeof node.value === 'string' && HEX.test(node.value)) {
          context.report({ node, messageId: 'hex', data: { value: node.value } });
          return;
        }
        // Numeric literal used as a style value.
        if (typeof node.value === 'number' && !ALLOWED_NUMBERS.has(node.value)) {
          // Only when it is the VALUE of an object property (not a key, not a JSX numeric prop),
          // inside a style context.
          const parent = node.parent;
          if (
            parent &&
            parent.type === 'Property' &&
            parent.value === node &&
            isInStyleContext(parent)
          ) {
            context.report({ node, messageId: 'size', data: { value: node.value } });
          }
        }
      },
    };
  },
};
