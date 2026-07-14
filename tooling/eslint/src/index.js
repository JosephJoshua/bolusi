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
    name: 'bolusi/money',
    files: ['packages/schemas/src/**/*.{ts,tsx}', 'packages/modules/src/**/*.{ts,tsx}'],
    rules: {
      'bolusi/no-float-money': 'error',
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
