import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getI18nInstance } from '@bolusi/i18n';
import { ALL_MODULES } from '@bolusi/modules';
import { beforeAll, expect, test } from 'vitest';

import { CLIENT_SCREEN_MODULES } from '../src/bootstrap/module-catalogs.js';
import { bootstrapI18n } from '../src/i18n.js';

test('every exported module screen has exactly one catalog registration', () => {
  const pkg = JSON.parse(
    readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/modules/package.json'),
      'utf8',
    ),
  ) as { exports: Record<string, unknown> };
  const screenIds = Object.keys(pkg.exports)
    .filter((key) => key.startsWith('./') && key.endsWith('/screens'))
    .map((key) => key.slice(2, -'/screens'.length));

  expect(screenIds).toContain('notes');
  expect(CLIENT_SCREEN_MODULES.map((module) => module.moduleId).sort()).toEqual(screenIds.sort());
  for (const id of screenIds) expect(ALL_MODULES.map((module) => module.id)).toContain(id);
});

beforeAll(async () => {
  // Exercise production registration, not the screen-test fixtures' registration.
  await bootstrapI18n({ read: () => Promise.resolve(null), write: () => Promise.resolve() });
});

function leaves(tree: Readonly<Record<string, unknown>>, prefix = ''): [string, unknown][] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? leaves(value as Record<string, unknown>, path)
      : [[path, value] as [string, unknown]];
  });
}

for (const module of CLIENT_SCREEN_MODULES) {
  test(`${module.moduleId} ships matching, nonblank translations that resolve after boot`, () => {
    const idEntries = leaves(module.catalogs.id);
    const enEntries = leaves(module.catalogs.en);
    expect(idEntries.length).toBeGreaterThan(0);
    expect(idEntries.map(([key]) => key).sort()).toEqual(enEntries.map(([key]) => key).sort());

    for (const locale of ['id', 'en'] as const) {
      for (const [key, value] of leaves(module.catalogs[locale])) {
        expect(typeof value, `${locale}:${key}`).toBe('string');
        expect(String(value).trim(), `${locale}:${key}`).not.toBe('');
        expect(
          getI18nInstance().getResource(locale, 'translation', `${module.moduleId}.${key}`),
        ).toBe(value);
      }
    }
  });
}
