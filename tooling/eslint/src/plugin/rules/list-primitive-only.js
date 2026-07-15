// bolusi/list-primitive-only — design-system §3.13 / §7, made ENFORCED rather than merely stated.
//
// §3.13 asserts as fact that screens render collections through the `List` primitive and never a
// raw `FlatList` / `SectionList` / `.map()` of rows. Until this rule, nothing checked that: the
// guarantee lived in prose, and the first screen to forget it would have shipped a non-virtualized
// list onto the 2 GB target (§0) with every gate green. That is precisely the claim-vs-code gap
// CLAUDE.md §2.11 exists to close, so §3.13's parenthetical — "a convention until enforced by task
// 24's screen import-boundary lint rule" — is discharged here.
//
// WHY THIS MATTERS BEYOND STYLE. `List` owns two things structurally (§3.13): the windowing config
// (`getItemLayout` + fixed `touch.row` height, written once) and the four §5 states as a
// discriminated union. A screen that reaches past it loses BOTH — it silently drops virtualization
// AND regains the ability to render `[]` as "empty" when the truth is `unauthorized` (FR-1036).
//
// SCOPE (set by the shared config): apps/mobile and packages/modules/**/screens — i.e. screen code.
// `packages/ui` is deliberately NOT in scope: it is the one package that MAY reach for the RN
// primitive, because wrapping it is its job. That asymmetry IS the boundary this rule draws.
//
// WHAT COUNTS AS A VIOLATION — every route to the primitive, not just the tidy one. A rule that
// catches only `import { FlatList } from 'react-native'` is trivially bypassed by the other
// spellings, and a guard with a documented hole is a guard that reports green for the wrong reason:
//   1. Named import:      import { FlatList } from 'react-native';
//   2. Named re-export:   export { FlatList } from 'react-native';
//   3. Namespace access:  import * as RN from 'react-native'; RN.FlatList
//   3b. DEFAULT import:   import RN from 'react-native';       RN.FlatList
//   4. CJS destructure:   const { FlatList } = require('react-native');
//   5. CJS member:        require('react-native').FlatList
//
// (3b) is the same bug as (3) — the module namespace object reached through an untracked binding —
// and it escaped the first version of this rule for the same reason the JSX spelling of (3) did:
// the visitor only knew about bindings it had explicitly collected. `react-native` is CJS, so under
// `esModuleInterop` a DEFAULT import yields the whole module object and `RN.FlatList` works exactly
// like the namespace form. It lints AND typechecks clean, which is what makes it worth guarding: a
// silent, working, non-virtualized list on the 2 GB target. Caught by review (T-12 — test the class,
// not the instance) after the first fix addressed only the instance.
//
// KNOWN, DELIBERATELY UNGUARDED — recorded so the hole is a decision, not an oversight:
//   - `export * from 'react-native'` (re-exports the primitive without naming it),
//   - computed access `RN['FlatList']`,
//   - dynamic `await import('react-native')`.
// All three are contrived in screen code and none can be written by accident; catching them needs
// scope analysis this rule deliberately does not do. If one ever appears, it is a code-review
// finding, not a lint gap.
//
// An import of the TYPE alone (`import type { FlatListProps }`) is not a violation: a type cannot
// render a row. Type-only specifiers are skipped explicitly.

/** The virtualized collection primitives `@bolusi/ui`'s `List` wraps (design-system §3.13). */
const FORBIDDEN = new Set(['FlatList', 'SectionList', 'VirtualizedList']);

const SOURCE = 'react-native';

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Screens render collections through @bolusi/ui `List`, never a raw react-native FlatList/SectionList/VirtualizedList (design-system §3.13).',
    },
    schema: [
      {
        type: 'object',
        properties: {
          // Escape hatch for the one legitimate case: a test double that re-exports the primitive
          // for the test lane. Must name exact paths — never a glob — so an exemption is a visible,
          // reviewable line rather than a wildcard that quietly grows.
          allowFiles: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      forbidden:
        "`{{name}}` is @bolusi/ui's to wrap, not a screen's to import (design-system §3.13). Render collections through the `List` primitive: it owns virtualization (`getItemLayout`, windowSize — a raw list over a year of history dies on the 2 GB target) and the four §5 states as a discriminated union, so `unauthorized` cannot render as `empty`.",
    },
  },

  create(context) {
    const allowFiles = context.options[0]?.allowFiles ?? [];
    const filename = (context.filename ?? '').split('\\').join('/');
    if (allowFiles.some((allowed) => filename.endsWith(allowed))) return {};

    /**
     * Local bindings that hold the `react-native` MODULE OBJECT — i.e. anything `X.FlatList` can be
     * reached through. Both `import * as RN` and `import RN` land here: `react-native` is CJS, so
     * under `esModuleInterop` the default import IS the module object, and the two spellings are
     * indistinguishable at the use site.
     */
    const namespaces = new Set();

    /** Report `node` for the forbidden primitive `name`. */
    const report = (node, name) => context.report({ node, messageId: 'forbidden', data: { name } });

    /** Is this a `require('react-native')` call? */
    const isRequireOfRn = (node) =>
      node?.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require' &&
      node.arguments.length === 1 &&
      node.arguments[0].type === 'Literal' &&
      node.arguments[0].value === SOURCE;

    return {
      // (1) import { FlatList } from 'react-native'   — and (3/3b) `import * as RN` / `import RN`
      ImportDeclaration(node) {
        if (node.source.value !== SOURCE) return;
        // `import type { … }` cannot render anything.
        if (node.importKind === 'type') return;
        for (const specifier of node.specifiers) {
          // Both spellings of "the module object" — see `namespaces` above.
          if (
            specifier.type === 'ImportNamespaceSpecifier' ||
            specifier.type === 'ImportDefaultSpecifier'
          ) {
            namespaces.add(specifier.local.name);
            continue;
          }
          if (specifier.type !== 'ImportSpecifier') continue;
          if (specifier.importKind === 'type') continue;
          const imported = specifier.imported.name ?? specifier.imported.value;
          if (FORBIDDEN.has(imported)) report(specifier, imported);
        }
      },

      // (2) export { FlatList } from 'react-native'
      ExportNamedDeclaration(node) {
        if (node.source?.value !== SOURCE) return;
        if (node.exportKind === 'type') return;
        for (const specifier of node.specifiers) {
          if (specifier.exportKind === 'type') continue;
          const local = specifier.local.name ?? specifier.local.value;
          if (FORBIDDEN.has(local)) report(specifier, local);
        }
      },

      // (3) RN.FlatList   (5) require('react-native').FlatList
      MemberExpression(node) {
        if (node.computed || node.property.type !== 'Identifier') return;
        if (!FORBIDDEN.has(node.property.name)) return;
        const isNamespace = node.object.type === 'Identifier' && namespaces.has(node.object.name);
        if (isNamespace || isRequireOfRn(node.object)) report(node, node.property.name);
      },

      // (3b) <RN.FlatList /> — JSX member access is a JSXMemberExpression, NOT a MemberExpression,
      // so the visitor above never sees it. This is the namespace bypass's most likely spelling (a
      // screen writes JSX, not `const L = RN.FlatList`), and the rule's own suite is what caught
      // that it was unguarded (CLAUDE.md §2.11 — the guard was watched going red here).
      JSXMemberExpression(node) {
        if (node.property.type !== 'JSXIdentifier') return;
        if (!FORBIDDEN.has(node.property.name)) return;
        if (node.object.type === 'JSXIdentifier' && namespaces.has(node.object.name)) {
          report(node, node.property.name);
        }
      },

      // (4) const { FlatList } = require('react-native');
      VariableDeclarator(node) {
        if (!isRequireOfRn(node.init) || node.id.type !== 'ObjectPattern') return;
        for (const property of node.id.properties) {
          if (property.type !== 'Property' || property.key.type !== 'Identifier') continue;
          if (FORBIDDEN.has(property.key.name)) report(property, property.key.name);
        }
      },
    };
  },
};
