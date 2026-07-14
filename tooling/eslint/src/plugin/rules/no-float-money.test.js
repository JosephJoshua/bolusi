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
    // non-integer numeric literal in a schema file (literal prong on by default)
    {
      code: `const surcharge = 0.5;`,
      errors: [{ messageId: 'nonIntegerLiteral' }],
    },
  ],
});

// The shared config disables the numeric-literal prong outside schema files (F1):
// screens/UI code with fractional literals must pass while the other prongs stay live.
tester.run('no-float-money (non-schema files: numericLiterals off)', rule, {
  valid: [
    {
      code: `const style = { opacity: 0.5 };`,
      options: [{ numericLiterals: false }],
      filename: '/repo/packages/modules/src/notes/screens/NoteCard.tsx',
    },
    {
      code: `const image = { quality: 0.7 };`,
      options: [{ numericLiterals: false }],
      filename: '/repo/packages/modules/src/notes/screens/CameraSheet.tsx',
    },
  ],
  invalid: [
    // the Zod and money-identifier prongs still fire with the literal prong off
    {
      code: `const priceIdr = z.number();`,
      options: [{ numericLiterals: false }],
      filename: '/repo/packages/modules/src/notes/screens/NoteCard.tsx',
      errors: [{ messageId: 'zNumberWithoutInt' }],
    },
    {
      code: `const x = parseFloat(amount);`,
      options: [{ numericLiterals: false }],
      filename: '/repo/packages/modules/src/notes/screens/NoteCard.tsx',
      errors: [{ messageId: 'floatOnMoney' }],
    },
  ],
});
