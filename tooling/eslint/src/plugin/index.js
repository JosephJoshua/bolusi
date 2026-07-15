// eslint-plugin-bolusi — the custom rules (08-stack-and-repo §5.2), packaged inside
// @bolusi/eslint-config (one workspace) and exposed via the `bolusi` plugin namespace.
import boundaries from './rules/boundaries.js';
import noFloatMoney from './rules/no-float-money.js';
import noHardcodedStrings from './rules/no-hardcoded-strings.js';
import noOpTableUpdate from './rules/no-op-table-update.js';
import noTokenLiterals from './rules/no-token-literals.js';

/** @type {import('eslint').ESLint.Plugin} */
const plugin = {
  meta: {
    name: 'eslint-plugin-bolusi',
    version: '0.0.0',
  },
  rules: {
    boundaries,
    'no-float-money': noFloatMoney,
    'no-hardcoded-strings': noHardcodedStrings,
    'no-op-table-update': noOpTableUpdate,
    // Added task 23 (design-system §7 lint (a)). Scoped in the shared config below.
    'no-token-literals': noTokenLiterals,
  },
};

export default plugin;
