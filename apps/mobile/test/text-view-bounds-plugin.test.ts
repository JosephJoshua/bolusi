// Android 15+ TextViews dropped the last word of a label React Native had sized to fit (QA runs 1 to 5).
import { describe, expect, test } from 'vitest';

import {
  TEXT_VIEW_STYLE,
  applyTextViewBoundsForWidth,
} from '../plugins/withTextViewBoundsForWidth.js';

type Xml = Parameters<typeof applyTextViewBoundsForWidth>[0];

function styles(): Xml {
  return {
    resources: {
      style: [
        {
          $: { name: 'AppTheme', parent: 'Theme.AppCompat.Light.NoActionBar' },
          item: [{ $: { name: 'colorPrimary' }, _: '@color/colorPrimary' }],
        },
      ],
    },
  } as unknown as Xml;
}

function items(xml: Xml, name: string): Record<string, string> {
  const style = xml.resources.style!.find((s) => s.$.name === name)!;
  return Object.fromEntries(style.item.map((i) => [i.$.name, i._]));
}

describe('TextView bounds-for-width plugin', () => {
  test('the app theme uses a TextView style with bounds-for-width off, keeping its other items', () => {
    const out = applyTextViewBoundsForWidth(styles());
    expect(items(out, 'AppTheme')).toEqual({
      colorPrimary: '@color/colorPrimary',
      'android:textViewStyle': `@style/${TEXT_VIEW_STYLE}`,
    });
    expect(items(out, TEXT_VIEW_STYLE)).toEqual({ 'android:useBoundsForWidth': 'false' });
  });

  test('running twice changes nothing more', () => {
    const once = applyTextViewBoundsForWidth(styles());
    const twice = applyTextViewBoundsForWidth(once);
    expect(twice.resources.style).toHaveLength(2);
    expect(items(twice, TEXT_VIEW_STYLE)).toEqual({ 'android:useBoundsForWidth': 'false' });
  });
});
