/**
 * Text and text inputs that draw at the system font size after it changes with the app open.
 *
 * On Android a live font size change leaves text measured at the old size: React's next commit
 * brings back its own text nodes, with their old measures, so text draws at the new size inside
 * old boxes (QA runs on PR #45). Fresh text nodes measure at the new size, so these remount ONLY
 * the text nodes when the font scale changes. The screens around them keep their state, so an open
 * form and whatever was typed into it survive. MainActivity tells JS the new scale
 * (apps/mobile/plugins/withActivityConfigChanges.ts).
 *
 * Every text in the app goes through these instead of `react-native`'s (the lint rule says so).
 */
import { createContext, useContext, type ComponentPropsWithRef, type ReactNode } from 'react';
import { Text as RNText, TextInput as RNTextInput, useWindowDimensions } from 'react-native';

const FontScaleContext = createContext(1);

/** Feeds the system font scale to every `Text` below. Put it once at the app's root. */
export function FontScaleProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const { fontScale } = useWindowDimensions();
  return <FontScaleContext.Provider value={fontScale}>{children}</FontScaleContext.Provider>;
}

export function Text(props: ComponentPropsWithRef<typeof RNText>): React.JSX.Element {
  return <RNText key={useContext(FontScaleContext)} {...props} />;
}

/** The bare input under the design system's fields. Screens use `TextInput` or `SearchField`. */
export function NativeTextInput(
  props: ComponentPropsWithRef<typeof RNTextInput>,
): React.JSX.Element {
  return <RNTextInput key={useContext(FontScaleContext)} {...props} />;
}
