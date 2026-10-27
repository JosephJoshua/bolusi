// Config plugin: TextViews lay out text the way React Native measured it on Android 15 and newer.
//
// From targetSdk 35, a TextView sizes lines by each glyph's drawn bounds (`useBoundsForWidth`),
// while React Native measures with advance widths. When the two disagree, a single-line label the
// layout sized to fit loses its last word: the QA device (Android 16) drew "Tidak dicek" as
// "Tidak" in a pill whose box held the whole text (RN issues #53286, #57110). This restores the
// pre-15 behaviour for every TextView in the app through the theme's default TextView style.
//
// No relative `.ts` imports, for the reason given in withHarnessActivity.ts.
import { AndroidConfig, withAndroidStyles, type ConfigPlugin } from 'expo/config-plugins';

export const TEXT_VIEW_STYLE = 'BolusiTextView';

type StylesXml = AndroidConfig.Resources.ResourceXML;

/** Pure: the app theme points its default TextView style at one that turns bounds-for-width off. */
export function applyTextViewBoundsForWidth(xml: StylesXml): StylesXml {
  let out = AndroidConfig.Styles.assignStylesValue(xml, {
    add: true,
    name: 'android:useBoundsForWidth',
    value: 'false',
    parent: { name: TEXT_VIEW_STYLE, parent: 'android:Widget.TextView' },
  });
  out = AndroidConfig.Styles.assignStylesValue(out, {
    add: true,
    name: 'android:textViewStyle',
    value: `@style/${TEXT_VIEW_STYLE}`,
    parent: AndroidConfig.Styles.getAppThemeGroup(),
  });
  return out;
}

const withTextViewBoundsForWidth: ConfigPlugin = (config) =>
  withAndroidStyles(config, (mod) => {
    mod.modResults = applyTextViewBoundsForWidth(mod.modResults);
    return mod;
  });

export default withTextViewBoundsForWidth;
