// Shared TypeScript rules plus checks for data integrity, platform boundaries and localization.
import tseslint from 'typescript-eslint';
import bolusi from './plugin/index.js';
export { bolusi };
const LOCATION_FLOAT_CARVE_OUT = {
  allowFloatFiles: ['packages/schemas/src/envelope.ts'],
  allowFloatProps: ['lat', 'lng', 'accuracyMeters'],
};
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
      '**/.claude/**',
      'apps/desktop/release/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    name: 'bolusi/base',
    plugins: { bolusi },
    rules: {
      'bolusi/no-op-table-update': 'error',
      'bolusi/no-media-column-update': 'error',
      'bolusi/no-legacy-upload-api': 'error',
      'bolusi/boundaries': 'error',
      'bolusi/permission-module-prefix': 'error',
      'bolusi/runtime-emission-allowlist': [
        'error',
        {
          sanctionedTypes: [
            'auth.user_switched',
            'auth.session_ended',
            'auth.permission_denied',
            'auth.pin_locked_out',
            'auth.device_enrolled',
          ],
          allowFiles: [
            'packages/core/src/runtime/execute.ts',
            'packages/core/test/oplog/_fixtures.ts',
            'packages/core/test/oplog/append.test.ts',
            'packages/core/test/oplog/chain.test.ts',
            'packages/core/test/oplog/tamper-fixtures.test.ts',
            'packages/db-client/test/op-store.test.ts',
          ],
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    name: 'bolusi/handler-purity',
    files: [
      'packages/modules/src/**/*.{commands,queries,handlers}.{ts,tsx}',
      'packages/modules/src/**/{commands,queries,handlers}.ts',
    ],
    rules: {
      'bolusi/no-clock-in-handlers': 'error',
    },
  },
  {
    name: 'bolusi/cjs-configs',
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    name: 'bolusi/rule-fixture-exemption',
    files: ['tooling/eslint/src/plugin/rules/*.test.js'],
    rules: {
      'bolusi/no-op-table-update': 'off',
      'bolusi/no-media-column-update': 'off',
      'bolusi/no-legacy-upload-api': 'off',
      'bolusi/boundaries': 'off',
    },
  },
  {
    name: 'bolusi/permission-registry-fixture-exemption',
    files: ['packages/core/test/authz/registry.test.ts'],
    rules: {
      'bolusi/permission-module-prefix': 'off',
    },
  },
  {
    name: 'bolusi/op-log-enforcement-allowlist',
    files: [
      'packages/db-server/migrations/0003_operations.ts',
      'packages/db-server/test/append-only.test.ts',
      'apps/server/test/integration/oplog/sec-oplog-07.test.ts',
    ],
    rules: {
      'bolusi/no-op-table-update': [
        'error',
        {
          allowFiles: [
            'packages/db-server/migrations/0003_operations.ts',
            'packages/db-server/test/append-only.test.ts',
            'apps/server/test/integration/oplog/sec-oplog-07.test.ts',
          ],
        },
      ],
    },
  },
  {
    name: 'bolusi/oplog-client-bookkeeping-allowlist',
    files: ['packages/core/src/oplog/bookkeeping.ts'],
    rules: {
      'bolusi/no-op-table-update': [
        'error',
        {
          allowFiles: ['packages/core/src/oplog/bookkeeping.ts'],
          allowColumns: ['syncStatus', 'syncedAt', 'rejectionCode', 'rejectionReason'],
        },
      ],
    },
  },
  {
    name: 'bolusi/money',
    files: ['packages/schemas/src/**/*.{ts,tsx}', 'packages/modules/src/**/*.{ts,tsx}'],
    rules: {
      'bolusi/no-float-money': ['error', { numericLiterals: false, ...LOCATION_FLOAT_CARVE_OUT }],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'zod',
              allowImportNames: ['z'],
              message:
                'Import only `z` from zod in schema code — `import { float64 } from "zod"` bypasses bolusi/no-float-money (08 §5.2). Use z.int() / z.number().int().',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'bolusi/money-schema-files',
    files: [
      'packages/schemas/src/**/*.{ts,tsx}',
      'packages/modules/src/**/*.schema.{ts,tsx}',
      'packages/modules/src/**/{schema,schemas,ops,operations,commands,queries}.ts',
    ],
    rules: {
      'bolusi/no-float-money': ['error', { numericLiterals: true, ...LOCATION_FLOAT_CARVE_OUT }],
    },
  },
  {
    name: 'bolusi/i18n-strings',
    files: [
      'apps/mobile/**/*.{ts,tsx,js,jsx}',
      'packages/modules/src/**/screens/**/*.{ts,tsx}',
      'packages/ui/src/**/*.{ts,tsx}',
      'apps/desktop/src/**/*.{ts,tsx}',
      'packages/modules/src/**/desktop/**/*.{ts,tsx}',
      'packages/ui-web/src/**/*.{ts,tsx}',
    ],
    ignores: ['packages/ui/src/**/*.test.{ts,tsx}', 'packages/ui-web/src/**/*.test.{ts,tsx}'],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'bolusi/no-hardcoded-strings': 'error',
    },
  },
  {
    name: 'bolusi/no-direct-intl',
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    ignores: ['packages/i18n/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.object.name='Intl']",
          message:
            'Do not construct Intl formatters outside packages/i18n — use the @bolusi/i18n formatters.',
        },
        {
          selector: "CallExpression[callee.object.name='Intl']",
          message:
            'Do not call Intl directly outside packages/i18n — use the @bolusi/i18n formatters.',
        },
      ],
    },
  },
  {
    name: 'bolusi/app-typed',
    files: [
      'apps/server/src/**/*.ts',
      'apps/mobile/src/**/*.ts',
      'apps/mobile/src/**/*.tsx',
      'apps/desktop/src/**/*.ts',
      'apps/desktop/src/**/*.tsx',
    ],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    languageOptions: {
      parserOptions: { projectService: true },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    name: 'bolusi/oplog-no-http',
    files: ['apps/server/src/oplog/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'hono',
              message:
                'src/oplog is HTTP-free (task 07): the pipeline is in-process; HTTP wiring is task 16.',
            },
            {
              name: '@hono/node-server',
              message: 'src/oplog is HTTP-free (task 07): no server/transport in the pipeline.',
            },
            {
              name: '@hono/zod-validator',
              message:
                'src/oplog is HTTP-free (task 07): request validation belongs to the route (task 16).',
            },
            {
              name: 'ws',
              message: 'src/oplog is HTTP-free (task 07): no sockets in the pipeline.',
            },
            {
              name: 'node:http',
              message: 'src/oplog is HTTP-free (task 07): the pipeline runs in-process.',
            },
            {
              name: 'node:https',
              message: 'src/oplog is HTTP-free (task 07): the pipeline runs in-process.',
            },
            {
              name: 'node:http2',
              message: 'src/oplog is HTTP-free (task 07): the pipeline runs in-process.',
            },
          ],
          patterns: [
            {
              group: ['hono/*', '@hono/*'],
              message:
                'src/oplog is HTTP-free (task 07): no Hono in the pipeline; the route (task 16) calls in.',
            },
          ],
        },
      ],
    },
  },
);
