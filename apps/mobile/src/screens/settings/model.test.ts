import { DEFAULT_LOCALE, LOCALES, SELECTABLE_LOCALES } from '@bolusi/i18n';
import { describe, expect, test, vi } from 'vitest';

import {
  categoryNameKey,
  channelImportance,
  defaultMuteState,
  localeNameKey,
  localeOptions,
  MUTABLE_PUSH_CATEGORIES,
  type SettingsDeps,
} from './model.js';

function deps(overrides: Partial<SettingsDeps> = {}): SettingsDeps {
  return {
    setDeviceLocale: vi.fn(async () => undefined),
    setChannelImportance: vi.fn(async () => undefined),
    setLocalePreference: null,
    ...overrides,
  };
}

describe('the language toggle offers exactly id/en — `zh` is absent (07-i18n §1)', () => {
  test('the options are id and en', () => {
    expect([...localeOptions].sort()).toEqual(['en', 'id']);
  });

  test('`zh` is NOT offered, even though it exists in the locale model', () => {
    // zh is scaffolded in the type + fallback chain but has no catalog in v0. Offering it would
    // render raw key names — and the user who picked it could not read their way back here.
    expect(localeOptions).not.toContain('zh');
    expect(LOCALES).toContain('zh');
  });

  test('the options ARE `SELECTABLE_LOCALES` — this screen curates no list of its own', () => {
    // The guard that matters (CLAUDE.md §2.8): when zh becomes selectable in V2 it must arrive by
    // changing 07-i18n's constant, not by remembering to edit a screen. Asserting identity with the
    // constant is what makes a hand-rolled `['id','en']` here fail.
    expect(localeOptions).toBe(SELECTABLE_LOCALES);
  });

  test('id is the default — Indonesian-first is the product, not a fallback', () => {
    expect(DEFAULT_LOCALE).toBe('id');
    expect(localeOptions[0]).toBe('id');
  });

  test('each option renders through a catalog key, never a hardcoded language name', () => {
    expect(localeNameKey('id')).toBe('core.language.id');
    expect(localeNameKey('en')).toBe('core.language.en');
  });
});

describe('the settings deps seam (07-i18n §1.2)', () => {
  // `changeLocale` was DELETED (task 138 item 2): device-locale writes happen inline in
  // `Root`/`SettingsScreen`, and the per-user `setLocalePreference` seam is wired to the existing
  // `platform.user_locale_changed` op separately (task 138 item 4 — this test's scope-guard on
  // "no op emitted" moves there once the emit lands).
  test('the v0 wiring passes null for the per-user seam until it is wired', () => {
    expect(deps().setLocalePreference).toBeNull();
  });
});

describe('one mute toggle per api/04-push §3 VISIBLE category', () => {
  test('the categories are exactly conflict and device', () => {
    expect([...MUTABLE_PUSH_CATEGORIES]).toEqual(['conflict', 'device']);
  });

  test('`sync` has no toggle — it is data-only, so a switch would do nothing (§3)', () => {
    // §3's table: sync's "Visible notification" column is "No". A mute toggle for a category that
    // never shows a notification is a control that lies about having an effect.
    expect(MUTABLE_PUSH_CATEGORIES as readonly string[]).not.toContain('sync');
  });

  test('nothing is muted by default — both categories are rare and actionable', () => {
    expect(defaultMuteState()).toEqual({ conflict: false, device: false });
  });

  test('mute maps to channel importance, never to dropping the payload (§5)', () => {
    // `min` still delivers — it just does not interrupt — so the deep link keeps working for a user
    // who muted the noise but not the information.
    expect(channelImportance(true)).toBe('min');
    expect(channelImportance(false)).toBe('default');
  });

  test('every category resolves a name key (T-14 denominator)', () => {
    let covered = 0;
    for (const category of MUTABLE_PUSH_CATEGORIES) {
      expect(categoryNameKey(category)).toBe(`push.${category}.title`);
      covered += 1;
    }
    expect(covered).toBe(MUTABLE_PUSH_CATEGORIES.length);
    expect(covered).toBeGreaterThan(0);
  });
});
