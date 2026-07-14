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
      const level = block.rules?.[ruleId];
      if (level !== undefined) return level;
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
