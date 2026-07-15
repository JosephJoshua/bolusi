import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';

import rule from './list-primitive-only.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

// The typescript-eslint parser, for the same reason boundaries.test.js uses it: it understands
// `import type` / `import { type X }` (importKind), which espree cannot parse at all. Those are
// VALID cases here — a type cannot render a row — so without this parser the rule's most important
// non-violation would be untestable.
const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

tester.run('list-primitive-only', rule, {
  valid: [
    // The sanctioned path: the `List` primitive, which owns virtualization + the four §5 states.
    { code: `import { List } from '@bolusi/ui'; const el = <List state={state} />;` },
    // Non-collection RN primitives are untouched — this rule draws ONE boundary, not a blanket ban.
    { code: `import { View, Text, Pressable, ScrollView } from 'react-native';` },
    // A type-only import cannot render a row.
    { code: `import type { FlatListProps } from 'react-native';` },
    { code: `import { type FlatList } from 'react-native';` },
    // A same-named export from somewhere else is not react-native's primitive.
    { code: `import { FlatList } from './doubles/react-native.js';` },
    // A namespace import is fine until it is used to reach the primitive.
    { code: `import * as RN from 'react-native'; const v = RN.View;` },
    // Likewise a default import — the binding is only a violation at the use site.
    { code: `import RN from 'react-native'; const v = RN.View;` },
    // A default import of something ELSE named RN is not react-native's module object.
    { code: `import RN from './doubles/react-native.js'; const L = RN.FlatList;` },
    // Non-react-native require.
    { code: `const { FlatList } = require('./local-double.js');` },
    // A property named FlatList on an unrelated object is not an import of the primitive.
    { code: `const registry = {}; const x = registry.FlatList;` },
    // allowFiles: the test double legitimately re-exports the primitive for the test lane.
    {
      code: `export { FlatList } from 'react-native';`,
      filename: '/repo/apps/mobile/test/doubles/react-native.tsx',
      options: [{ allowFiles: ['apps/mobile/test/doubles/react-native.tsx'] }],
    },
  ],

  invalid: [
    // (1) The tidy spelling.
    {
      code: `import { FlatList } from 'react-native';`,
      errors: [{ messageId: 'forbidden', data: { name: 'FlatList' } }],
    },
    {
      code: `import { SectionList } from 'react-native';`,
      errors: [{ messageId: 'forbidden', data: { name: 'SectionList' } }],
    },
    {
      code: `import { VirtualizedList } from 'react-native';`,
      errors: [{ messageId: 'forbidden', data: { name: 'VirtualizedList' } }],
    },
    // Mixed with legitimate primitives — only the forbidden specifier is reported.
    {
      code: `import { View, FlatList, Text } from 'react-native';`,
      errors: [{ messageId: 'forbidden' }],
    },
    // Renaming does not launder it.
    {
      code: `import { FlatList as Rows } from 'react-native';`,
      errors: [{ messageId: 'forbidden' }],
    },
    // (2) Re-export.
    {
      code: `export { FlatList } from 'react-native';`,
      errors: [{ messageId: 'forbidden' }],
    },
    // (3) Namespace access — the bypass a naive import-only rule misses.
    {
      code: `import * as RN from 'react-native'; const el = <RN.FlatList data={rows} />;`,
      errors: [{ messageId: 'forbidden' }],
    },
    {
      code: `import * as RN from 'react-native'; const L = RN.SectionList;`,
      errors: [{ messageId: 'forbidden' }],
    },
    // (3b) DEFAULT-import namespace — `react-native` is CJS, so under esModuleInterop the default
    // import IS the module object and `RN.FlatList` renders a real, non-virtualized list. This
    // spelling linted AND typechecked clean until review caught it (T-12: the first fix addressed
    // the JSX instance of this bug, not the class — an untracked binding holding the namespace).
    {
      code: `import RN from 'react-native'; const el = <RN.FlatList data={rows} renderItem={() => null} />;`,
      errors: [{ messageId: 'forbidden', data: { name: 'FlatList' } }],
    },
    {
      code: `import RN from 'react-native'; const L = RN.FlatList;`,
      errors: [{ messageId: 'forbidden' }],
    },
    {
      code: `import ReactNative from 'react-native'; const el = <ReactNative.VirtualizedList data={rows} />;`,
      errors: [{ messageId: 'forbidden' }],
    },
    // A default AND named import together — both routes stay guarded.
    {
      code: `import RN, { View } from 'react-native'; const el = <RN.SectionList data={rows} />;`,
      errors: [{ messageId: 'forbidden' }],
    },
    // (4) CJS destructure.
    {
      code: `const { FlatList } = require('react-native');`,
      errors: [{ messageId: 'forbidden' }],
    },
    // (5) CJS member access.
    {
      code: `const L = require('react-native').FlatList;`,
      errors: [{ messageId: 'forbidden' }],
    },
    // allowFiles is exact-path, not a wildcard: a different file gets no pass.
    {
      code: `import { FlatList } from 'react-native';`,
      filename: '/repo/apps/mobile/src/screens/notes/NotesList.tsx',
      options: [{ allowFiles: ['apps/mobile/test/doubles/react-native.tsx'] }],
      errors: [{ messageId: 'forbidden' }],
    },
  ],
});
