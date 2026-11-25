import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import rule from './no-cut-text.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

tester.run('no-cut-text', rule, {
  valid: [
    { code: '<span className="block text-body break-words" />' },
    { code: '<OverflowText text={name} className="text-body" />' },
    { code: "const note = 'truncated payload';" },
    { code: "const cls = 'line-clamp';" },
  ],
  invalid: [
    { code: '<span className="block truncate text-small" />', errors: [{ messageId: 'cut' }] },
    { code: '<dd className="line-clamp-2 text-body" />', errors: [{ messageId: 'cut' }] },
    { code: "clsx('md:truncate', cls)", errors: [{ messageId: 'cut' }] },
    { code: 'const c = `text-ellipsis ${x}`;', errors: [{ messageId: 'cut' }] },
  ],
});
