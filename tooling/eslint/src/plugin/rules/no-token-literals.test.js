import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import rule from './no-token-literals.js';

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

tester.run('no-token-literals', rule, {
  valid: [
    // The same values via tokens are the sanctioned path.
    {
      code: `const s = StyleSheet.create({ box: { height: touch.primary, backgroundColor: color.primary } });`,
    },
    { code: `const el = <View style={{ padding: space.lg }} />;` },
    // Non-style numeric props are legitimate and must not trip (the reason we detect style context
    // structurally rather than by property name).
    { code: `const el = <List windowSize={7} initialNumToRender={10} />;` },
    { code: `const el = <Text numberOfLines={2} />;` },
    { code: `const el = <FreshnessCell suppressedCount={3} />;` },
    // 0 and 1 carry no scale meaning.
    { code: `const s = StyleSheet.create({ box: { flex: 1, opacity: 0 } });` },
    // Percentage/string dimensions are not scale literals.
    { code: `const s = StyleSheet.create({ fill: { width: '100%' } });` },
    // A plain constant that happens to be a number, not in a style.
    { code: `const PIN_LENGTH = 6;` },
    // Object keys are never values.
    { code: `const map = { 7: 'seven' };` },
  ],
  invalid: [
    // Raw hex anywhere.
    {
      code: `const s = StyleSheet.create({ box: { backgroundColor: '#1D4ED8' } });`,
      errors: [{ messageId: 'hex' }],
    },
    {
      code: `const el = <View style={{ borderColor: '#B91C1C' }} />;`,
      errors: [{ messageId: 'hex' }],
    },
    // Raw dp value in a StyleSheet.create style.
    {
      code: `const s = StyleSheet.create({ box: { height: 56 } });`,
      errors: [{ messageId: 'size' }],
    },
    // Raw dp value in an inline style prop.
    {
      code: `const el = <View style={{ padding: 24 }} />;`,
      errors: [{ messageId: 'size' }],
    },
    // Nested style object still counts.
    {
      code: `const s = StyleSheet.create({ row: { margin: space.lg, borderRadius: 12 } });`,
      errors: [{ messageId: 'size' }],
    },
  ],
});
