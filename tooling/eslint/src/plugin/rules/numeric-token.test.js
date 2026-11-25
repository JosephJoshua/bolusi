import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import rule from './numeric-token.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });

tester.run('numeric-token', rule, {
  valid: [
    { code: 'const s = { amount: { ...type.title, ...numeric } };' },
    { code: 'const s = { fontWeight: "600" };' },
  ],
  invalid: [
    { code: "const s = { fontVariant: ['tabular-nums'] };", errors: [{ messageId: 'raw' }] },
    { code: "const s = { 'fontVariant': ['tabular-nums'] };", errors: [{ messageId: 'raw' }] },
  ],
});
