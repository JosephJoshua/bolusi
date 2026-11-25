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
import {
  Animated,
  Text as RNText,
  TextInput as RNTextInput,
  useWindowDimensions,
} from 'react-native';

const FontScaleContext = createContext(1);

/** Feeds the system font scale to every `Text` below. Put it once at the app's root. */
export function FontScaleProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const { fontScale } = useWindowDimensions();
  return <FontScaleContext.Provider value={fontScale}>{children}</FontScaleContext.Provider>;
}

/**
 * Text never cuts itself off: labels, titles, chips and amounts wrap or the layout changes
 * (design guide §9). The one exception, a long value someone typed shown in a list row, is
 * `ValueText`.
 */
export type TextProps = Omit<
  ComponentPropsWithRef<typeof RNText>,
  'numberOfLines' | 'ellipsizeMode'
>;

export function Text(props: TextProps): React.JSX.Element {
  return <RNText key={useContext(FontScaleContext)} {...props} />;
}

/**
 * A value someone typed (a customer's name, a part's model list) shown in a list row, cut to
 * `lines` with an ellipsis. Its full text must be one tap away. It marks itself so the browser
 * layout check allows the cut.
 */
export function ValueText({
  lines,
  ...props
}: TextProps & { readonly lines: number }): React.JSX.Element {
  const marked = { ...props, dataSet: { ellipsis: 'value' } } as TextProps;
  return <RNText key={useContext(FontScaleContext)} numberOfLines={lines} {...marked} />;
}

/**
 * `Text` that takes animated styles, for figures and titles that move. The whole animated text
 * remounts on a new font scale, not just its text node inside: native-driven animations stay
 * bound to the view they started on, so a fresh view under the same animated node crashes Android
 * ("Animated node is already attached to a view").
 */
export function AnimatedText(
  props: Omit<ComponentPropsWithRef<typeof Animated.Text>, 'numberOfLines' | 'ellipsizeMode'>,
): React.JSX.Element {
  return <Animated.Text key={useContext(FontScaleContext)} {...props} />;
}

/** The bare input under the design system's fields. Screens use `TextInput` or `SearchField`. */
export function NativeTextInput(
  props: ComponentPropsWithRef<typeof RNTextInput>,
): React.JSX.Element {
  return <RNTextInput key={useContext(FontScaleContext)} {...props} />;
}
