// eslint-plugin-bolusi — the custom rules (08-stack-and-repo §5.2), packaged inside
// @bolusi/eslint-config (one workspace) and exposed via the `bolusi` plugin namespace.
import boundaries from './rules/boundaries.js';
import listPrimitiveOnly from './rules/list-primitive-only.js';
import noClockInHandlers from './rules/no-clock-in-handlers.js';
import noFloatMoney from './rules/no-float-money.js';
import noHardcodedStrings from './rules/no-hardcoded-strings.js';
import noOpTableUpdate from './rules/no-op-table-update.js';
import noTokenLiterals from './rules/no-token-literals.js';
import permissionModulePrefix from './rules/permission-module-prefix.js';
import runtimeEmissionAllowlist from './rules/runtime-emission-allowlist.js';

/** @type {import('eslint').ESLint.Plugin} */
const plugin = {
  meta: {
    name: 'eslint-plugin-bolusi',
    version: '0.0.0',
  },
  rules: {
    boundaries,
    // Added task 24 (design-system §3.13/§7). Scoped to SCREEN code in the shared config below —
    // `packages/ui` is out of scope on purpose: wrapping the RN primitive is its job, and that
    // asymmetry is the boundary. Discharges §3.13's "a convention until enforced by task 24's
    // screen import-boundary lint rule".
    'list-primitive-only': listPrimitiveOnly,
    'no-float-money': noFloatMoney,
    'no-hardcoded-strings': noHardcodedStrings,
    'no-op-table-update': noOpTableUpdate,
    // Added task 23 (design-system §7 lint (a)). Scoped in the shared config below.
    'no-token-literals': noTokenLiterals,
    // Added task 09 (02-permissions §2 CI lint). Whole-repo in the shared config below —
    // a module manifest can live anywhere, and the rule only fires on the manifest shape.
    'permission-module-prefix': permissionModulePrefix,
    // Added task 10 (04-module-contract §5.2 purity rule). Scoped to module command-handler
    // files in the shared config below.
    'no-clock-in-handlers': noClockInHandlers,
    // Added task 10 (04-module-contract §5.1 — the "lint-enforced" in "exactly five
    // lint-enforced exceptions"). Whole-repo in the shared config below: a non-command append
    // is a problem wherever it is written.
    'runtime-emission-allowlist': runtimeEmissionAllowlist,
  },
};

export default plugin;
