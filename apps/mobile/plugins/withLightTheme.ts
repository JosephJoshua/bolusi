// Config plugin: the Android app theme is light whatever the phone's dark mode says.
//
// The app is light-only (`userInterfaceStyle: 'light'`), but the template's theme is DayNight, and
// expo-system-ui only switches AppCompat to light after the activity has started. MainActivity
// handles `uiMode` itself (withActivityConfigChanges), so nothing recreates it with the light
// theme: on a phone in dark mode the window stayed dark, and the status and navigation bars around
// the light screens drew dark grey with light icons (QA on PR #76). A light parent makes the window,
// the bar icons and the navigation bar scrim light from the first frame.
//
// No relative `.ts` imports, for the reason given in withHarnessActivity.ts.
import { AndroidConfig, withAndroidStyles, type ConfigPlugin } from 'expo/config-plugins';

export const LIGHT_THEME_PARENT = 'Theme.AppCompat.Light.NoActionBar';

type StylesXml = AndroidConfig.Resources.ResourceXML;

/** Pure: the app theme's parent is the light AppCompat theme; its items are kept. */
export function applyLightTheme(xml: StylesXml): StylesXml {
  const theme = AndroidConfig.Styles.getAppThemeGroup();
  for (const style of xml.resources.style ?? []) {
    if (style.$.name === theme.name) style.$.parent = LIGHT_THEME_PARENT;
  }
  return xml;
}

const withLightTheme: ConfigPlugin = (config) =>
  withAndroidStyles(config, (mod) => {
    mod.modResults = applyLightTheme(mod.modResults);
    return mod;
  });

export default withLightTheme;
