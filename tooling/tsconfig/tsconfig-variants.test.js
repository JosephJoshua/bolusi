import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));

test('base.json is platform-free with the 08 §4.1 load-bearing flags', () => {
  const { compilerOptions: opts } = read('base.json');
  expect(opts.strict).toBe(true);
  expect(opts.noUncheckedIndexedAccess).toBe(true);
  expect(opts.exactOptionalPropertyTypes).toBe(true);
  expect(opts.verbatimModuleSyntax).toBe(true);
  expect(opts.isolatedModules).toBe(true);
  expect(opts.lib).toEqual(['ES2022']);
  expect(opts.types).toEqual([]);
});

test('node.json only adds Node ambient types on top of base', () => {
  const { compilerOptions: opts } = read('node.json');
  expect(opts.types).toEqual(['node']);
});

test('react-native.json keeps types empty and enables JSX', () => {
  const { compilerOptions: opts } = read('react-native.json');
  expect(opts.types).toEqual([]);
  expect(opts.jsx).toBe('react-jsx');
});
