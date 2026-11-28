import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import rule from './single-choice-control.js';

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

tester.run('single-choice-control', rule, {
  valid: [
    { code: '<ToggleChip selected={line.done} onToggle={() => toggle(line)} />' },
    { code: "<ToggleChip selected={c === v} onToggle={() => set(c === v ? '' : v)} />" },
    { code: '<Chip selected={a === b} onToggle={() => set(b)} />' },
  ],
  invalid: [
    {
      code: '<ToggleChip selected={method === row.id} onToggle={() => setMethod(row.id)} />',
      errors: [{ messageId: 'radio' }],
    },
  ],
});
