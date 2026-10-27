// Config plugin: MainActivity handles a system font-size, display-size or language change itself.
//
// Without these, Android DESTROYS and recreates the activity when the person changes the font size
// in system settings with the app open. The first Android QA run showed what that does here: a blank
// white screen until force-stop, and the intake in progress gone.
//
// Handling the change ourselves means finishing what React Native leaves out on the new
// architecture: it tells JS the new font scale only on the next resume, so a live change never
// reached `useWindowDimensions` (App.tsx remounts the screens on it). `FONT_SCALE_SYNC_KOTLIN` does
// three steps each time the font scale changes, in this order:
//   1. Refresh the display metrics at once. Back from Settings, a measure pass can run before
//      anything posted, and text measured with the old metrics is cached under the new scale.
//   2. Measure every React root at once too, so the surface's layout carries the new scale before
//      JS hears of it. Text measurements are cached by scale, and a remount at the old scale reuses
//      them. Back from Settings, the activity's resume tells JS before anything posted runs, which
//      left the header and bottom bar at their old size on the QA device.
//   3. Re-emit Dimensions through React Native's own "font scale changed" check (posted, so the
//      process has its new configuration too).
//
// No relative `.ts` imports, for the reason given in withHarnessActivity.ts.
import {
  AndroidConfig,
  withAndroidManifest,
  withMainActivity,
  type ConfigPlugin,
} from 'expo/config-plugins';

/** Added to whatever the template already lists (keyboard, orientation, screenSize, uiMode, …). */
export const EXTRA_CONFIG_CHANGES = ['fontScale', 'density', 'locale', 'layoutDirection'] as const;

/** Pure: the main activity's `android:configChanges` with every extra present once. */
export function addConfigChanges(
  androidManifest: AndroidConfig.Manifest.AndroidManifest,
): AndroidConfig.Manifest.AndroidManifest {
  const activity = AndroidConfig.Manifest.getMainActivityOrThrow(androidManifest);
  const current = (activity.$['android:configChanges'] ?? '').split('|').filter(Boolean);
  const merged = [...current, ...EXTRA_CONFIG_CHANGES.filter((c) => !current.includes(c))];
  activity.$['android:configChanges'] = merged.join('|');
  return androidManifest;
}

const FONT_SCALE_SYNC_MARKER = '// bolusi: font scale sync';

const FONT_SCALE_SYNC_IMPORTS = [
  'android.content.res.Configuration',
  'android.view.View',
  'android.view.ViewGroup',
  'com.facebook.react.ReactApplication',
  'com.facebook.react.ReactRootView',
  'com.facebook.react.bridge.LifecycleEventListener',
  'com.facebook.react.uimanager.DisplayMetricsHolder',
] as const;

// `DeviceInfo.onHostResume` is React Native's own "re-read the font scale and emit Dimensions if it
// changed", reached through the public listener interface because the module class is internal.
export const FONT_SCALE_SYNC_KOTLIN = `
  ${FONT_SCALE_SYNC_MARKER} (plugins/withActivityConfigChanges.ts)
  private var syncedFontScale = Float.NaN

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    if (newConfig.fontScale == syncedFontScale) return
    DisplayMetricsHolder.initDisplayMetrics(this)
    remeasureReactRoots(window.decorView)
    window.decorView.post { syncFontScale() }
  }

  private fun syncFontScale() {
    val reactContext = (application as ReactApplication).reactHost?.currentReactContext ?: return
    syncedFontScale = resources.configuration.fontScale
    DisplayMetricsHolder.initDisplayMetrics(reactContext)
    (reactContext.getNativeModule("DeviceInfo") as? LifecycleEventListener)?.onHostResume()
  }

  private fun remeasureReactRoots(view: View) {
    if (view is ReactRootView) {
      view.requestLayout()
      if (view.width > 0 && view.height > 0) {
        view.measure(
          View.MeasureSpec.makeMeasureSpec(view.width, View.MeasureSpec.EXACTLY),
          View.MeasureSpec.makeMeasureSpec(view.height, View.MeasureSpec.EXACTLY),
        )
      }
      return
    }
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) remeasureReactRoots(view.getChildAt(i))
    }
  }
`;

/** Pure: the generated `MainActivity.kt` with the font scale sync added once. */
export function addFontScaleSync(mainActivity: string): string {
  if (mainActivity.includes(FONT_SCALE_SYNC_MARKER)) return mainActivity;
  const classOpen = /class MainActivity\s*:\s*ReactActivity\(\)\s*\{\n/;
  if (!classOpen.test(mainActivity)) {
    throw new Error('withActivityConfigChanges: MainActivity is not the expected ReactActivity');
  }
  const missing = FONT_SCALE_SYNC_IMPORTS.filter(
    (name) => !new RegExp(`^import ${name.replaceAll('.', '\\.')}$`, 'm').test(mainActivity),
  );
  const withImports = mainActivity.replace(
    /^(package [\w.]+\n)/m,
    `$1${missing.map((name) => `\nimport ${name}`).join('')}\n`,
  );
  return withImports.replace(classOpen, (open) => `${open}${FONT_SCALE_SYNC_KOTLIN}\n`);
}

const withActivityConfigChanges: ConfigPlugin = (config) => {
  config = withAndroidManifest(config, (mod) => {
    mod.modResults = addConfigChanges(mod.modResults);
    return mod;
  });
  return withMainActivity(config, (mod) => {
    if (mod.modResults.language !== 'kt') {
      throw new Error('withActivityConfigChanges: expected a Kotlin MainActivity');
    }
    mod.modResults.contents = addFontScaleSync(mod.modResults.contents);
    return mod;
  });
};

export default withActivityConfigChanges;
