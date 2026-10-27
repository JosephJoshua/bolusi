// A system font-size change recreated MainActivity and blanked the app (first Android QA run).
import { describe, expect, test } from 'vitest';

import {
  FONT_SCALE_SYNC_KOTLIN,
  addConfigChanges,
  addFontScaleSync,
} from '../plugins/withActivityConfigChanges.js';

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

// The Expo SDK 57 template's MainActivity.kt, trimmed to what the transform touches.
const TEMPLATE_MAIN_ACTIVITY = `package com.bolusi.app

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    setTheme(R.style.AppTheme);
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "main"
}
`;

describe('MainActivity font scale sync', () => {
  test('adds the override inside the class and its imports after the package line', () => {
    const out = addFontScaleSync(TEMPLATE_MAIN_ACTIVITY);
    expect(out.startsWith('package com.bolusi.app\n')).toBe(true);
    expect(out).toContain('class MainActivity : ReactActivity() {\n' + FONT_SCALE_SYNC_KOTLIN);
    for (const name of [
      'android.content.res.Configuration',
      'com.facebook.react.ReactRootView',
      'com.facebook.react.bridge.LifecycleEventListener',
      'com.facebook.react.uimanager.DisplayMetricsHolder',
    ]) {
      expect(out).toMatch(new RegExp(`^import ${name.replaceAll('.', '\\.')}$`, 'm'));
    }
    // The template's own members are kept.
    expect(out).toContain('override fun getMainComponentName(): String = "main"');
  });

  test('re-measures React roots and re-emits the font scale when it changes', () => {
    expect(FONT_SCALE_SYNC_KOTLIN).toContain('override fun onConfigurationChanged');
    // Refreshed before the post, so no measure pass at the new scale uses the old metrics.
    expect(FONT_SCALE_SYNC_KOTLIN).toMatch(
      /DisplayMetricsHolder\.initDisplayMetrics\(this\)\n\s*window\.decorView\.post/,
    );
    expect(FONT_SCALE_SYNC_KOTLIN).toContain(
      'DisplayMetricsHolder.initDisplayMetrics(reactContext)',
    );
    expect(FONT_SCALE_SYNC_KOTLIN).toContain('view.requestLayout()');
    // Measured now, before DeviceInfo tells JS, so a remount measures at the new scale.
    expect(FONT_SCALE_SYNC_KOTLIN.indexOf('remeasureReactRoots(window.decorView)')).toBeLessThan(
      FONT_SCALE_SYNC_KOTLIN.indexOf('getNativeModule("DeviceInfo")'),
    );
    expect(FONT_SCALE_SYNC_KOTLIN).toContain('view.measure(');
    expect(FONT_SCALE_SYNC_KOTLIN).toContain('getNativeModule("DeviceInfo")');
  });

  test('a second prebuild is a no-op', () => {
    const once = addFontScaleSync(TEMPLATE_MAIN_ACTIVITY);
    expect(addFontScaleSync(once)).toBe(once);
  });

  test('does not repeat an import the template already has', () => {
    const withImport = TEMPLATE_MAIN_ACTIVITY.replace(
      'import android.os.Build\n',
      'import android.os.Build\nimport android.view.View\n',
    );
    const out = addFontScaleSync(withImport);
    expect(out.match(/^import android\.view\.View$/gm)).toHaveLength(1);
  });

  test('fails the prebuild when the template no longer matches', () => {
    expect(() => addFontScaleSync('package x\n\nclass MainActivity : Activity() {\n}\n')).toThrow(
      /expected ReactActivity/,
    );
  });
});
