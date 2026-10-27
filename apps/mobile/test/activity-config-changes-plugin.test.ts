// A system font-size change recreated MainActivity and blanked the app (first Android QA run).
import { describe, expect, test } from 'vitest';

import { addConfigChanges } from '../plugins/withActivityConfigChanges.js';

function manifest(configChanges?: string) {
  return {
    manifest: {
      $: {},
      application: [
        {
          $: { 'android:name': '.MainApplication' },
          activity: [
            {
              $: {
                'android:name': '.MainActivity',
                ...(configChanges === undefined ? {} : { 'android:configChanges': configChanges }),
              },
              'intent-filter': [
                {
                  action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
                  category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
                },
              ],
            },
          ],
        },
      ],
    },
  } as unknown as Parameters<typeof addConfigChanges>[0];
}

function changesOf(m: Parameters<typeof addConfigChanges>[0]): string[] {
  return (m.manifest.application![0]!.activity![0]!.$['android:configChanges'] ?? '').split('|');
}

describe('MainActivity config changes', () => {
  test('keeps the template list and adds font scale, density, locale and layout direction', () => {
    const out = addConfigChanges(manifest('keyboard|orientation|screenSize|uiMode'));
    expect(changesOf(out)).toEqual([
      'keyboard',
      'orientation',
      'screenSize',
      'uiMode',
      'fontScale',
      'density',
      'locale',
      'layoutDirection',
    ]);
  });

  test('never duplicates an entry, so a second prebuild is a no-op', () => {
    const once = addConfigChanges(manifest('fontScale|uiMode'));
    const twice = addConfigChanges(once);
    expect(changesOf(twice)).toEqual([
      'fontScale',
      'uiMode',
      'density',
      'locale',
      'layoutDirection',
    ]);
  });
});
