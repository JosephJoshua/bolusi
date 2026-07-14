// eslint-plugin-bolusi — the four custom rules (08-stack-and-repo §5.2), packaged inside
// @bolusi/eslint-config (one workspace) and exposed via the `bolusi` plugin namespace.
import boundaries from './rules/boundaries.js';
import noFloatMoney from './rules/no-float-money.js';
import noHardcodedStrings from './rules/no-hardcoded-strings.js';
import noOpTableUpdate from './rules/no-op-table-update.js';

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
  },
};

export default plugin;
