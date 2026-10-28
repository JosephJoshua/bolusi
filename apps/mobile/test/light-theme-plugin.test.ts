// On a phone in dark mode the system bars around the light screens drew dark grey (QA on PR #76).
import { describe, expect, test } from 'vitest';

import { LIGHT_THEME_PARENT, applyLightTheme } from '../plugins/withLightTheme.js';

type Xml = Parameters<typeof applyLightTheme>[0];

function styles(): Xml {
  return {
    resources: {
      style: [
        {
          $: { name: 'AppTheme', parent: 'Theme.AppCompat.DayNight.NoActionBar' },
          item: [{ $: { name: 'colorPrimary' }, _: '@color/colorPrimary' }],
        },
        {
          $: { name: 'Theme.App.SplashScreen', parent: 'Theme.SplashScreen' },
          item: [{ $: { name: 'postSplashScreenTheme' }, _: '@style/AppTheme' }],
        },
      ],
    },
  } as unknown as Xml;
}

describe('light theme plugin', () => {
  test('the app theme is light and keeps its items; other styles are left alone', () => {
    const out = applyLightTheme(styles()).resources.style!;
    expect(out[0]!.$.parent).toBe(LIGHT_THEME_PARENT);
    expect(out[0]!.item).toHaveLength(1);
    expect(out[1]!.$.parent).toBe('Theme.SplashScreen');
  });
});
