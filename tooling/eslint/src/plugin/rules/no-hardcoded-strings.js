// bolusi/no-hardcoded-strings (08-stack-and-repo §5.2; label mechanism owned by 07-i18n).
// Scope (set by the shared config): apps/mobile + packages/modules/**/screens.
// Implemented depth: JSX text/literal children, user-visible JSX attributes, alert/toast
// call arguments. Deeper coverage (template literals, notification payloads) lands with
// task 22 (i18n) / task 23 (ui-kit).

const HAS_LETTER = /\p{L}/u;
const USER_VISIBLE_ATTRS = new Set([
  'title',
  'label',
  'placeholder',
  'accessibilityLabel',
  'alt',
  'text',
  'message',
]);
const ALERT_CALL_NAMES = new Set(['alert', 'toast']);

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'No user-visible hardcoded string literals — every label goes through the @bolusi/i18n catalog (ai-docs/07-i18n.md)',
    },
    messages: {
      hardcoded:
        'Hardcoded user-visible string. Use the @bolusi/i18n label catalog (ai-docs/07-i18n.md).',
    },
    schema: [],
  },
  create(context) {
    const report = (node) => context.report({ node, messageId: 'hardcoded' });

    return {
      JSXText(node) {
        if (HAS_LETTER.test(node.value)) report(node);
      },
      Literal(node) {
        if (typeof node.value !== 'string' || !HAS_LETTER.test(node.value)) return;
        const parent = node.parent;
        if (!parent) return;
        if (parent.type === 'JSXExpressionContainer') {
          const grandparent = parent.parent;
          if (
            grandparent &&
            (grandparent.type === 'JSXElement' || grandparent.type === 'JSXFragment')
          ) {
            report(node);
          } else if (
            grandparent &&
            grandparent.type === 'JSXAttribute' &&
            grandparent.name.type === 'JSXIdentifier' &&
            USER_VISIBLE_ATTRS.has(grandparent.name.name)
          ) {
            report(node);
          }
        } else if (
          parent.type === 'JSXAttribute' &&
          parent.name.type === 'JSXIdentifier' &&
          USER_VISIBLE_ATTRS.has(parent.name.name)
        ) {
          report(node);
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        const name =
          callee.type === 'Identifier'
            ? callee.name
            : callee.type === 'MemberExpression' &&
                !callee.computed &&
                callee.property.type === 'Identifier'
              ? callee.property.name
              : '';
        if (!ALERT_CALL_NAMES.has(name)) return;
        for (const arg of node.arguments) {
          if (
            arg.type === 'Literal' &&
            typeof arg.value === 'string' &&
            HAS_LETTER.test(arg.value)
          ) {
            report(arg);
          }
        }
      },
    };
  },
};
