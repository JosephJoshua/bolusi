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
    // The op log's append-only ENFORCEMENT, and the tests that prove it (task 05).
    // `bolusi/no-op-table-update` matches UPDATE/DELETE near `operations` in raw SQL, which
    // catches two files whose whole purpose is the opposite of mutating the log:
    //
    //   migrations/0003_operations.ts — `CREATE TRIGGER operations_no_update BEFORE UPDATE ON
    //     operations`: the DDL that INSTALLS the prohibition (10-db-schema §5).
    //   test/append-only.test.ts — the adversarial cases that attempt UPDATE/DELETE and assert
    //     both the trigger exception and the app role's grant denial (security-guide §3.1's
    //     "enforced three ways"). A test proving mutation is impossible has to attempt it.
    //
    // Scoped to these two exact paths via the rule's documented `allowFiles` option — the log
    // stays append-only everywhere else, including the rest of packages/db-server.
    name: 'bolusi/op-log-enforcement-allowlist',
    files: [
      'packages/db-server/migrations/0003_operations.ts',
      'packages/db-server/test/append-only.test.ts',
    ],
    rules: {
      'bolusi/no-op-table-update': [
        'error',
        {
          allowFiles: [
            'packages/db-server/migrations/0003_operations.ts',
            'packages/db-server/test/append-only.test.ts',
          ],
        },
      ],
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
    name: 'bolusi/i18n-strings',
    files: ['apps/mobile/**/*.{ts,tsx,js,jsx}', 'packages/modules/src/**/screens/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'bolusi/no-hardcoded-strings': 'error',
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
