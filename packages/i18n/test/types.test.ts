// Type-safety fixtures (07-i18n §3.4). These assert at COMPILE time — `pnpm typecheck` is the
// real gate here (tsconfig.json includes `test`), and @ts-expect-error inverts it: if a typo key
// ever started type-checking, the unused directive itself becomes the error.
import { describe, expect, it } from 'vitest';

import { resources } from '../src/generated/resources.js';
import { initI18n, t, type TranslationKey } from '../src/index.js';

describe('key typing', () => {
  it('rejects a key that is not in the catalog', () => {
    // @ts-expect-error — 'auth.pin.typo' is not a catalog key (07-i18n §3.4)
    expect(() => t('auth.pin.typo')).toBeTypeOf('function');
  });

  it('rejects a key that exists only as an intermediate node', () => {
    // @ts-expect-error — 'auth.pin' is a branch, not a leaf
    expect(() => t('auth.pin')).toBeTypeOf('function');
  });

  it('accepts real keys', () => {
    initI18n({ locale: 'id' });
    const key: TranslationKey = 'auth.pin.attemptsLeft';
    expect(t(key, { count: 2 })).toBe('Sisa 2 kesempatan');
  });

  it('types the bare i18next instance too, not just the t() wrapper', () => {
    const instance = initI18n({ locale: 'id' });
    // @ts-expect-error — the CustomTypeOptions augmentation covers i18next's own t
    expect(() => instance.t('auth.pin.typo')).toBeTypeOf('function');
  });
});

describe('generated resources', () => {
  it('keeps the checked-in catalog pristine across inits — i18next mutates its resource store', () => {
    const before = JSON.stringify(resources);

    const instance = initI18n({ locale: 'en' });
    instance.removeResourceBundle('en', 'translation');
    instance.addResourceBundle('en', 'translation', { core: {} }, true, true);

    expect(JSON.stringify(resources)).toBe(before);
    // A fresh instance is unaffected by the previous one's surgery.
    initI18n({ locale: 'en' });
    expect(t('core.action.save')).toBe('Save');
  });
});
