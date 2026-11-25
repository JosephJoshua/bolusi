import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import rule from './no-excuse-comments.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });

tester.run('no-excuse-comments', rule, {
  valid: [
    {
      code: '// The drawer check runs on the device only: the server records cash as it moved.\nf();',
    },
    { code: "const label = 'XXX-0001'; // a ticket number" },
    { code: "test('a ticket must carry every photo angle the store asks for now', f);" },
    { code: '/** Waits until the first frame arrives. */\nf();' },
  ],
  invalid: [
    { code: '// TODO: check the limit on the server\nf();', errors: [{ messageId: 'excuse' }] },
    { code: '// HACK around the race\nf();', errors: [{ messageId: 'excuse' }] },
    { code: '/* SQLite only for now. */\nf();', errors: [{ messageId: 'excuse' }] },
    { code: '// A workaround for the Android bug.\nf();', errors: [{ messageId: 'excuse' }] },
    { code: '// Temporary until the API lands.\nf();', errors: [{ messageId: 'excuse' }] },
    {
      code: '/** Inert until task 25 registers notes. */\nf();',
      errors: [{ messageId: 'excuse' }],
    },
    {
      code: '// KNOWN GAP: restored devices boot half-enrolled.\nf();',
      errors: [{ messageId: 'excuse' }],
    },
    { code: '// NOT YET IMPLEMENTED: the allow-matrix.\nf();', errors: [{ messageId: 'excuse' }] },
  ],
});
