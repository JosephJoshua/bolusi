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
    // 07-i18n §4.1 technical-literal exemptions
    { code: `const el = <Text style={{ fontFamily: 'Inter' }} />;` },
    { code: `const el = <Text accessibilityRole="header">{t('notes.list.title')}</Text>;` },
    { code: `const styles = { color: 'red' };` },
    { code: `logger.warn('note archived');` },
    { code: 'const url = `${base}/notes`;' },
    // a template with no words of its own is interpolation, not copy
    { code: 'const el = <Text>{`${count}`}</Text>;' },
    // catalog calls in display positions stay valid
    { code: `Alert.alert(t('notes.confirm.archive'));` },
    { code: `Toast.show(t('core.status.saved'));` },
    { code: `const el = <Button title={t('core.action.save')} />;` },
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
    // 07-i18n §4.1 display callees
    {
      code: `Alert.alert('Catatan tersimpan');`,
      errors: [{ messageId: 'hardcoded' }],
    },
    {
      // Toast.show is only reachable by qualified name — 'show' alone means nothing
      code: `Toast.show('Catatan tersimpan');`,
      errors: [{ messageId: 'hardcoded' }],
    },
    // 07-i18n §4.1 validateTemplate: template literals in display positions
    {
      code: 'const el = <Text>{`Simpan ${name}`}</Text>;',
      errors: [{ messageId: 'hardcoded' }],
    },
    {
      code: 'const el = <Button title={`Simpan ${name}`} />;',
      errors: [{ messageId: 'hardcoded' }],
    },
    {
      code: 'Alert.alert(`Gagal menyimpan ${name}`);',
      errors: [{ messageId: 'hardcoded' }],
    },
    // display attributes added for §4.1 parity
    {
      code: `const el = <Screen headerTitle="Catatan" />;`,
      errors: [{ messageId: 'hardcoded' }],
    },
    {
      code: `const el = <Pressable accessibilityHint="Membuka catatan" />;`,
      errors: [{ messageId: 'hardcoded' }],
    },
  ],
});
