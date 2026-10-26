// Config plugin: MainActivity handles a system font-size, display-size or language change itself.
//
// Without these, Android DESTROYS and recreates the activity when the person changes the font size
// in system settings with the app open. The first Android QA run showed what that does here: a blank
// white screen until force-stop, and the intake in progress gone.
//
// Handling the change ourselves means finishing what React Native leaves out on the new
// architecture. On `onConfigurationChanged` it re-reads the display metrics, but it only asks the
// screens to measure again when its own before/after comparison sees a difference, and it tells JS
// the new font scale only on the next resume. A live change from 1.3 back to 1.0 on the QA device
// kept JS at 1.3 and the text at its old size until a restart. `FONT_SCALE_SYNC_KOTLIN` does the
// three steps every time the font scale changes: refresh the metrics, re-measure every React root,
// and re-emit Dimensions so `useWindowDimensions` sees the new scale.
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

// Posted so it runs after both the process and the activity have their new configuration.
// `DeviceInfo.onHostResume` is React Native's own "re-read the font scale and emit Dimensions if it
// changed", reached through the public listener interface because the module class is internal.
export const FONT_SCALE_SYNC_KOTLIN = `
  ${FONT_SCALE_SYNC_MARKER} (plugins/withActivityConfigChanges.ts)
  private var syncedFontScale = Float.NaN

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    if (newConfig.fontScale == syncedFontScale) return
    window.decorView.post { syncFontScale() }
  }

  private fun syncFontScale() {
    val reactContext = (application as ReactApplication).reactHost?.currentReactContext ?: return
    syncedFontScale = resources.configuration.fontScale
    DisplayMetricsHolder.initDisplayMetrics(reactContext)
    remeasureReactRoots(window.decorView)
    (reactContext.getNativeModule("DeviceInfo") as? LifecycleEventListener)?.onHostResume()
    android.util.Log.i("BolusiFontScale", "synced fontScale=$syncedFontScale app=\${applicationContext.resources.configuration.fontScale} scaledDensity=\${DisplayMetricsHolder.getScreenDisplayMetrics().scaledDensity}")
  }

  private fun remeasureReactRoots(view: View) {
    if (view is ReactRootView) {
      view.requestLayout()
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
