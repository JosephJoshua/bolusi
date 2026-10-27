// Every reason a module's op rules refuse with has its own copy in every shipped locale, so a person
// is told what exactly was wrong instead of a generic "the data changed". A module that adds a
// reason without copy fails here.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_MODULES } from '@bolusi/modules';
import { describe, expect, test } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** A module's catalog: its own (`packages/modules/<id>/i18n`) or a platform one in @bolusi/i18n. */
function catalog(moduleId: string, locale: 'id' | 'en'): Record<string, unknown> {
  const own = join(ROOT, 'packages/modules', moduleId, 'i18n', `${locale}.json`);
  const file = existsSync(own)
    ? own
    : join(ROOT, 'packages/i18n/catalogs', moduleId, `${locale}.json`);
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

const WITH_RULES = ALL_MODULES.filter((module) =>
  Object.values(module.operations).some((declaration) => declaration.rule !== null),
);

test('the modules with rules are the ones expected (the denominator)', () => {
  expect(WITH_RULES.map((module) => module.id).sort()).toEqual(['notes', 'platform', 'repair']);
});

describe.each(WITH_RULES.map((module) => ({ id: module.id, reasons: module.refusals ?? [] })))(
  'the $id refusals',
  ({ id, reasons }) => {
    test('are declared', () => {
      expect(reasons.length).toBeGreaterThan(0);
    });

    for (const locale of ['id', 'en'] as const) {
      test(`each has ${locale} copy at ${id}.refusal.<reason>`, () => {
        const refusal = (catalog(id, locale).refusal ?? {}) as Record<string, unknown>;
        const missing = reasons.filter(
          (reason) => typeof refusal[reason] !== 'string' || refusal[reason] === '',
        );
        expect(missing).toEqual([]);
        // And no copy for a reason nothing can refuse with.
        expect(Object.keys(refusal).sort()).toEqual([...reasons].sort());
      });
    }
  },
);
