import { expect, test } from 'vitest';

import config, { bolusi } from './index.js';

test('all four bolusi custom rules are registered at error in the flat config', () => {
  expect(Object.keys(bolusi.rules).sort()).toEqual([
    'boundaries',
    'no-float-money',
    'no-hardcoded-strings',
    'no-op-table-update',
  ]);

  const ruleLevel = (ruleId) => {
    for (const block of config) {
      const entry = block.rules?.[ruleId];
      if (entry !== undefined) return Array.isArray(entry) ? entry[0] : entry;
    }
    return undefined;
  };

  expect(ruleLevel('bolusi/boundaries')).toBe('error');
  expect(ruleLevel('bolusi/no-op-table-update')).toBe('error');
  expect(ruleLevel('bolusi/no-float-money')).toBe('error');
  expect(ruleLevel('bolusi/no-hardcoded-strings')).toBe('error');
});

test('repo-wide rules are not scoped to a files subset', () => {
  const repoWide = config.find(
    (block) => block.rules?.['bolusi/boundaries'] === 'error' && !block.files,
  );
  expect(repoWide).toBeDefined();
  expect(repoWide.rules['bolusi/no-op-table-update']).toBe('error');
});

test('no-float-money literal prong is scoped to schema files only (F1)', () => {
  const broad = config.find((block) => block.name === 'bolusi/money');
  expect(broad.rules['bolusi/no-float-money']).toEqual(['error', { numericLiterals: false }]);
  expect(broad.files).toContain('packages/modules/src/**/*.{ts,tsx}');

  const schemaOnly = config.find((block) => block.name === 'bolusi/money-schema-files');
  expect(schemaOnly.rules['bolusi/no-float-money']).toEqual(['error', { numericLiterals: true }]);
  // the schema-file convention: whole schemas package + named module schema files
  expect(schemaOnly.files).toEqual([
    'packages/schemas/src/**/*.{ts,tsx}',
    'packages/modules/src/**/*.schema.{ts,tsx}',
    'packages/modules/src/**/{schema,schemas,ops,operations,commands,queries}.ts',
  ]);
  // within modules, only the named schema-file conventions — never screens or a catch-all
  const moduleGlobs = schemaOnly.files.filter((glob) => glob.startsWith('packages/modules/'));
  expect(moduleGlobs.length).toBeGreaterThan(0);
  expect(
    moduleGlobs.some((glob) => glob.includes('screens') || glob.endsWith('**/*.{ts,tsx}')),
  ).toBe(false);
});
