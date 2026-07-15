// bolusi/no-hardcoded-strings (08-stack-and-repo §5.2; label mechanism owned by 07-i18n).
// Scope (set by the shared config): apps/mobile + packages/modules/**/screens.
//
// Implements 07-i18n §4.1 in full: JSX text nodes, the display attribute list, the display
// callee list, and template literals in any of those positions (the rule's own
// `validateTemplate: true` equivalent). Non-display technical literals — testID, style values,
// object keys, log messages — are exempt by construction: only the positions below are checked.
//
// Extending the display lists is part of adding a new display API (§4.1). A bare
// `eslint-disable bolusi/no-hardcoded-strings` is treated as a defect in review.

const HAS_LETTER = /\p{L}/u;

/** JSX attributes that render text to the user (07-i18n §4.1). */
const USER_VISIBLE_ATTRS = new Set([
  'title',
  'label',
  'placeholder',
  'headerTitle',
  'accessibilityLabel',
  'accessibilityHint',
  'alt',
  'text',
  'message',
]);

/**
 * Display APIs whose arguments reach the user (07-i18n §4.1). Matched on the bare callee name
 * (`alert(…)`, `x.alert(…)`) and on the qualified name (`Alert.alert`, `Toast.show`) — the
 * qualified form is what catches `Toast.show`, whose property name alone is unremarkable.
 */
const DISPLAY_CALL_NAMES = new Set(['alert', 'toast', 'Alert.alert', 'Toast.show']);

/**
 * @param {import('estree').Expression | import('estree').Super} callee
 * @returns {{ bare: string, qualified: string }}
 */
function calleeNames(callee) {
  if (callee.type === 'Identifier') return { bare: callee.name, qualified: callee.name };
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier'
  ) {
    const bare = callee.property.name;
    const object = callee.object.type === 'Identifier' ? callee.object.name : '';
    return { bare, qualified: object ? `${object}.${bare}` : bare };
  }
  return { bare: '', qualified: '' };
}

/** A template literal is user-visible copy only if it has literal words of its own. */
function templateHasText(node) {
  return node.quasis.some((quasi) => HAS_LETTER.test(quasi.value.cooked ?? quasi.value.raw));
}

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

    /** Is this node in a position whose value is rendered to the user? */
    const isDisplayPosition = (node) => {
      const parent = node.parent;
      if (!parent) return false;

      // <Text>{'…'}</Text> / <Text>{`…`}</Text>, and title={'…'} / title={`…`}
      if (parent.type === 'JSXExpressionContainer') {
        const grandparent = parent.parent;
        if (!grandparent) return false;
        if (grandparent.type === 'JSXElement' || grandparent.type === 'JSXFragment') return true;
        return (
          grandparent.type === 'JSXAttribute' &&
          grandparent.name.type === 'JSXIdentifier' &&
          USER_VISIBLE_ATTRS.has(grandparent.name.name)
        );
      }

      // title="…"
      if (parent.type === 'JSXAttribute') {
        return parent.name.type === 'JSXIdentifier' && USER_VISIBLE_ATTRS.has(parent.name.name);
      }

      // Alert.alert('…') / Toast.show(`…`)
      if (parent.type === 'CallExpression' && parent.arguments.includes(node)) {
        const { bare, qualified } = calleeNames(parent.callee);
        return DISPLAY_CALL_NAMES.has(qualified) || DISPLAY_CALL_NAMES.has(bare);
      }

      return false;
    };

    return {
      JSXText(node) {
        if (HAS_LETTER.test(node.value)) report(node);
      },
      Literal(node) {
        if (typeof node.value !== 'string' || !HAS_LETTER.test(node.value)) return;
        if (isDisplayPosition(node)) report(node);
      },
      TemplateLiteral(node) {
        if (!templateHasText(node)) return;
        if (isDisplayPosition(node)) report(node);
      },
    };
  },
};
