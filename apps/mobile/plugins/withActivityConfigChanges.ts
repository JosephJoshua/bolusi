// Config plugin: MainActivity handles a system font-size, display-size or language change itself.
//
// Without these, Android DESTROYS and recreates the activity when the person changes the font size
// in system settings with the app open. The first Android QA run showed what that does here: a blank
// white screen until force-stop, and the intake in progress gone. React Native already follows these
// changes live (it re-reads the font scale and display metrics on `onConfigurationChanged`), so the
// activity has no reason to restart for them.
//
// No relative `.ts` imports, for the reason given in withHarnessActivity.ts.
import { AndroidConfig, withAndroidManifest, type ConfigPlugin } from 'expo/config-plugins';

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

const withActivityConfigChanges: ConfigPlugin = (config) =>
  withAndroidManifest(config, (mod) => {
    mod.modResults = addConfigChanges(mod.modResults);
    return mod;
  });

export default withActivityConfigChanges;
