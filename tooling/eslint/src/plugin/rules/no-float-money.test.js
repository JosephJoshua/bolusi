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

// Float CONSTRUCTORS (task 29). The rule's mandate is "no float money representations",
// so it must cover the whole class of Zod float constructors, not just `z.number`.
// Ground truth (zod 4.4.3): float-producing numeric ctors are `number`, `float32`,
// `float64`, `nan` and `coerce.number`; integer ctors are `int`/`int32`/`int64`/`bigint`.
const ENVELOPE = '/repo/packages/schemas/src/envelope.ts';
const PAYLOAD = '/repo/packages/modules/src/expenses/schema.ts';
// Mirrors the shared config's carve-out (tooling/eslint/src/index.js, `bolusi/money`).
const CARVE_OUT = {
  numericLiterals: false,
  allowFloatFiles: ['packages/schemas/src/envelope.ts'],
  allowFloatProps: ['lat', 'lng', 'accuracyMeters'],
};

tester.run('no-float-money (float constructors)', rule, {
  valid: [
    // integer constructors are the sanctioned shapes — none of these may be flagged
    { code: `const a = z.number().int();` },
    { code: `const b = z.coerce.number().int().min(1);` },
    { code: `const c = z.int();` },
    { code: `const d = z.int32();` },
    { code: `const e = z.bigint();` },
    // the location carve-out: allowlisted FILE *and* allowlisted PROP together
    {
      code: `const zLocation = z.strictObject({ lat: z.float64(), lng: z.float64(), accuracyMeters: z.float64() });`,
      options: [CARVE_OUT],
      filename: ENVELOPE,
    },
  ],
  invalid: [
    // THE REPORTED BUG: z.float64() money walks through the rule today
    {
      code: `const zAmountIdr = z.float64();`,
      errors: [
        {
          message:
            'z.float64() in a schema file — money is integer IDR, floats never (05-operation-log §3). Use z.number().int() / z.int().',
        },
      ],
    },
    // same class: float32
    {
      code: `const zAmt = z.float32();`,
      errors: [
        {
          message:
            'z.float32() in a schema file — money is integer IDR, floats never (05-operation-log §3). Use z.number().int() / z.int().',
        },
      ],
    },
    // same class: coercion produces a float unless .int() is chained
    {
      code: `const zTotal = z.coerce.number();`,
      errors: [{ messageId: 'zNumberWithoutInt' }],
    },
    // declaring float64 then .int() is a contradiction — still an error
    {
      code: `const zPrice = z.float64().int();`,
      errors: [{ messageId: 'zFloatConstructor' }],
    },
    // CARVE-OUT DENOMINATOR 1 — the PROP dimension is load-bearing: a money prop in the
    // allowlisted file is still caught (the file is not a blanket float pass).
    {
      code: `const zCore = z.object({ amountIdr: z.float64() });`,
      options: [CARVE_OUT],
      filename: ENVELOPE,
      errors: [{ messageId: 'zFloatConstructor' }],
    },
    // CARVE-OUT DENOMINATOR 2 — the FILE dimension is load-bearing: `lat` float64 in a
    // PAYLOAD schema is still caught. 05 §3 forbids floats in payloads; the carve-out is
    // legitimate only because location is envelope, not payload.
    {
      code: `const zFix = z.object({ lat: z.float64() });`,
      options: [CARVE_OUT],
      filename: PAYLOAD,
      errors: [{ messageId: 'zFloatConstructor' }],
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
