import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import rule from './no-hardcoded-strings.js';

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

tester.run('no-hardcoded-strings', rule, {
  valid: [
    // label-catalog call is the sanctioned path (07-i18n)
    { code: `const el = <Text>{t('notes.title')}</Text>;` },
    // non-user-visible attributes are fine
    { code: `const el = <View testID="notes-screen" />;` },
    // plain (non-JSX) string literals are out of scope for this rule
    { code: `const key = 'notes.title';` },
  ],
  invalid: [
    // JSX string literal child → error (primary fixture)
    {
      code: `const el = <Text>Simpan catatan</Text>;`,
      errors: [{ messageId: 'hardcoded' }],
    },
    // string literal in expression container child
    {
      code: `const el = <Text>{'Simpan'}</Text>;`,
      errors: [{ messageId: 'hardcoded' }],
    },
    // user-visible attribute
    {
      code: `const el = <Input placeholder="Nama pelanggan" />;`,
      errors: [{ messageId: 'hardcoded' }],
    },
    // alert() call argument
    {
      code: `alert('Catatan tersimpan');`,
      errors: [{ messageId: 'hardcoded' }],
    },
  ],
});
