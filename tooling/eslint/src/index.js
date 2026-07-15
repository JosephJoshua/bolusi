// Shared flat config (08-stack-and-repo §5.2): typescript-eslint stock rules where cheap
// plus the four bolusi custom rules — ALL at 'error', no inline-disable without a linked task.
import tseslint from 'typescript-eslint';

import bolusi from './plugin/index.js';

export { bolusi };

export default tseslint.config(
  {
    name: 'bolusi/ignores',
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.expo/**',
      '**/coverage/**',
      '**/android/**',
      '**/ios/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    name: 'bolusi/base',
    plugins: { bolusi },
    rules: {
      'bolusi/no-op-table-update': 'error',
      'bolusi/boundaries': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // CommonJS config files (metro.config.cjs) legitimately use require().
    name: 'bolusi/cjs-configs',
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // RuleTester fixtures are adversarial by design: the invalid-code strings inside
    // these suites intentionally contain the exact patterns the rules hunt for.
    name: 'bolusi/rule-fixture-exemption',
    files: ['tooling/eslint/src/plugin/rules/*.test.js'],
    rules: {
      'bolusi/no-op-table-update': 'off',
      'bolusi/boundaries': 'off',
    },
  },
  {
    // Zod-shape + money-identifier prongs everywhere in schemas/modules; the
    // numeric-literal prong is off here (UI code like `opacity: 0.5` is legitimate).
    name: 'bolusi/money',
    files: ['packages/schemas/src/**/*.{ts,tsx}', 'packages/modules/src/**/*.{ts,tsx}'],
    rules: {
      'bolusi/no-float-money': ['error', { numericLiterals: false }],
    },
  },
  {
    // Schema-file convention (08 §5.2): the numeric-literal prong fires only here.
    // All of packages/schemas is schema by definition; in packages/modules the
    // payload/command/query schema files are *.schema.ts(x) or
    // schema|schemas|ops|operations|commands|queries.ts — later tasks name files accordingly.
    name: 'bolusi/money-schema-files',
    files: [
      'packages/schemas/src/**/*.{ts,tsx}',
      'packages/modules/src/**/*.schema.{ts,tsx}',
      'packages/modules/src/**/{schema,schemas,ops,operations,commands,queries}.ts',
    ],
    rules: {
      'bolusi/no-float-money': ['error', { numericLiterals: true }],
    },
  },
  {
    // Scope extended task 23 to add `packages/ui` (08-stack §5.2 / design-system §7 lint (b)): the
    // design-system package receives resolved strings as props and must itself contain zero
    // user-visible literals. Test files are excluded — RN component tests legitimately pass literal
    // placeholder copy as props (testing-guide asserts KEYS/testIDs, never that copy; the copy is
    // inert fixture data), exactly as the repo already exempts RuleTester fixtures below.
    name: 'bolusi/i18n-strings',
    files: [
      'apps/mobile/**/*.{ts,tsx,js,jsx}',
      'packages/modules/src/**/screens/**/*.{ts,tsx}',
      'packages/ui/src/**/*.{ts,tsx}',
    ],
    ignores: ['packages/ui/src/**/*.test.{ts,tsx}'],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'bolusi/no-hardcoded-strings': 'error',
    },
  },
  {
    // Added task 23 — design-system §7 lint (a): color/size literals in `.tsx` are errors outside
    // tokens.ts. Scope per §7: packages/ui, apps/mobile, packages/modules/**/screens. `tokens.ts`
    // IS the vocabulary, so it is the single exemption; test files are out of scope (fixtures and
    // the RN doubles legitimately carry raw values — the package's own package-hygiene suite polices
    // src separately).
    name: 'bolusi/token-literals',
    files: [
      'packages/ui/src/**/*.{ts,tsx}',
      'apps/mobile/**/*.{ts,tsx}',
      'packages/modules/src/**/screens/**/*.{ts,tsx}',
    ],
    ignores: ['packages/ui/src/tokens.ts', '**/*.test.{ts,tsx}'],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'bolusi/no-token-literals': 'error',
    },
  },
  {
    // 07-i18n §5: @bolusi/i18n is the single formatting authority. UI code never touches Intl
    // directly — money/date/number rendering has locale rules (NBSP normalization, zero fraction
    // digits, day-first dates) that only the formatters apply. The i18n package itself is where
    // Intl legitimately lives, so it is the one exemption.
    name: 'bolusi/no-direct-intl',
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    ignores: ['packages/i18n/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.object.name='Intl']",
          message:
            'Do not construct Intl formatters outside packages/i18n — use the @bolusi/i18n formatters (ai-docs/07-i18n.md §5).',
        },
        {
          selector: "CallExpression[callee.object.name='Intl']",
          message:
            'Do not call Intl directly outside packages/i18n — use the @bolusi/i18n formatters (ai-docs/07-i18n.md §5).',
        },
      ],
    },
  },
  {
    name: 'bolusi/server-typed',
    files: ['apps/server/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    languageOptions: {
      parserOptions: { projectService: true },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
);
