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
      // Added task 09 — the 02-permissions §2 CI lint. Whole-repo and unscoped: it fires only on
      // the module-manifest shape (a literal `id` beside permissions/commands/queries), so it costs
      // nothing elsewhere and cannot miss a manifest that lands in an unexpected package.
      'bolusi/permission-module-prefix': 'error',
      // Added task 10 — 04-module-contract §5.1's "lint-enforced" five. Whole-repo and unscoped:
      // prong A fires only on the emission channel's shape, prong B only on a direct
      // `appendLocalOps` call, so it costs nothing elsewhere and cannot miss a non-command append
      // that lands in an unexpected package.
      //
      // `sanctionedTypes` is passed rather than baked into the rule so the closed set has ONE
      // definition (packages/core/src/runtime/runtime-emissions.ts, pinned to 04 §5.1 by core's
      // suite) — a hand-maintained copy inside the rule is how a sixth type gets in
      // (CLAUDE.md §2.8). Keep this list in step with that constant.
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
          // The command runtime IS the append path's caller (04 §5.1 steps 5–6) — it is the one
          // place a non-command append legitimately originates. Core's oplog suite and fixtures
          // drive `appendLocalOps` directly to test it, which is the same "a test proving
          // something is impossible has to attempt it" exemption the op-log rules already carry.
          allowFiles: [
            'packages/core/src/runtime/execute.ts',
            'packages/core/test/oplog/_fixtures.ts',
            'packages/core/test/oplog/append.test.ts',
            'packages/core/test/oplog/chain.test.ts',
            'packages/core/test/oplog/tamper-fixtures.test.ts',
          ],
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Added task 10 — 04-module-contract §5.2: command handlers are pure (no clock, no rng, no
    // network, no timers). Scoped to module command/query files by the same naming convention
    // 08 §5.2 established for `bolusi/no-float-money`, because that is where handlers live.
    //
    // DENOMINATOR NOTE (T-14): as of task 10 `packages/modules` contains no command files yet —
    // the notes module's commands land with task 25 — so this rule currently guards ZERO shipping
    // files. It is live at `error` from here so the first handler file lands under it, and its
    // RuleTester fixtures (no-clock-in-handlers.test.js) are what prove it fires. The runtime
    // purity guard (packages/core/test/runtime/purity.test.ts) covers handlers behaviourally in
    // the meantime, including the dynamic accesses this rule cannot see.
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
    // The permission-registry assembly suite (task 09) proves that a manifest declaring another
    // module's permission is a STARTUP FAILURE (02-permissions §3.2 rule 4). Asserting that
    // rejection requires constructing the rejected manifest — the same reason
    // `packages/db-server/test/append-only.test.ts` is exempted from `no-op-table-update` above: a
    // test proving something is impossible has to attempt it.
    //
    // Scoped to this ONE file, and only this rule. The lint's real targets — module manifests under
    // packages/modules — are untouched, and the rule's own RuleTester fixtures need no exemption
    // (their violations live inside string literals, which eslint never parses as code).
    name: 'bolusi/permission-registry-fixture-exemption',
    files: ['packages/core/test/authz/registry.test.ts'],
    rules: {
      'bolusi/permission-module-prefix': 'off',
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
    // The client's SINGLE syncStatus bookkeeping mutator (task 06; 08-stack §5.2, 05 §2.3).
    // COLUMN-SCOPED: `markSyncResult` in this exact file may UPDATE `operations` only for the
    // four client bookkeeping columns below — the rule rejects any other `.set()` key (a
    // signed-core column), a dynamic/spread `.set()`, or a `deleteFrom` (DELETE never allowed,
    // 05 §1). Every OTHER core file (draft.ts, append.ts, verify.ts, …) still fails on any
    // `updateTable`/`deleteFrom('operations')`, proven by the rule's own fixture suite.
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
