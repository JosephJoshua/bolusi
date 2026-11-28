import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import rule from './no-row-divider.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

tester.run('no-row-divider', rule, {
  valid: [
    { code: 'const s = { row: { paddingVertical: 8 } };' },
    { code: 'const s = { total: { borderTopWidth: 1 } };' },
    { code: 'const s = { [borderBottomWidth]: 1 };' },
  ],
  invalid: [
    {
      code: 'const s = { row: { borderBottomWidth: 1, borderBottomColor: c } };',
      errors: [{ messageId: 'divider' }],
    },
    { code: "const s = { 'borderBottomWidth': 1 };", errors: [{ messageId: 'divider' }] },
  ],
});
