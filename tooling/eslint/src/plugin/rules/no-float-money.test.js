import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import rule from './no-float-money.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

tester.run('no-float-money', rule, {
  valid: [
    // integer money — the only sanctioned numeric shape (05-operation-log §3)
    { code: `const priceIdr = z.number().int().nonnegative();` },
    // .int() anywhere in the chain counts
    { code: `const qty = z.number().min(0).int();` },
    // integer literals are fine
    { code: `const pageSize = 50;` },
    // parseFloat on a non-money identifier is out of this rule's scope
    { code: `const ratio = parseFloat(scaleFactor);` },
  ],
  invalid: [
    // z.number() without .int() in a schema file → error (primary fixture)
    {
      code: `const priceIdr = z.number();`,
      errors: [{ messageId: 'zNumberWithoutInt' }],
    },
    {
      code: `const total = z.number().nonnegative();`,
      errors: [{ messageId: 'zNumberWithoutInt' }],
    },
    // parseFloat on a money identifier → error (primary fixture)
    {
      code: `const x = parseFloat(amount);`,
      errors: [{ messageId: 'floatOnMoney' }],
    },
    {
      code: `const x = Number.parseFloat(totalFee);`,
      errors: [{ messageId: 'floatOnMoney' }],
    },
    {
      code: `const label = priceIdr.toFixed(2);`,
      // 2 is an integer literal, so only the toFixed report fires
      errors: [{ messageId: 'floatOnMoney' }],
    },
    // non-integer numeric literal in a schema file
    {
      code: `const surcharge = 0.5;`,
      errors: [{ messageId: 'nonIntegerLiteral' }],
    },
  ],
});
