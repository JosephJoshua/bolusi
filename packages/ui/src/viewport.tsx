/**
 * How much room the app has, so a screen can use a tablet's width instead of stretching a phone
 * layout across it.
 *
 * Width classes follow Material 3's window size classes: `compact` is a phone in portrait, `medium`
 * a small tablet or a phone in landscape, `expanded` a tablet in landscape or a big tablet. A
 * screen picks a layout by class (one pane, or a list beside its detail) and never by device type:
 * a phone in split-screen is compact, a tablet in split-screen may be too.
 *
 * On a device the app fills its window, so the window size is the answer. Where the app sits in a
 * smaller box (the web preview draws it in a phone-width column), `ViewportProvider` measures that
 * box and the screens size themselves to it.
 */
import { createContext, useContext, useState, type ReactNode } from 'react';
import { View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';

export type WidthClass = 'compact' | 'medium' | 'expanded';

/** Material 3 window size class breakpoints, in dp. */
export const breakpoint = Object.freeze({ medium: 600, expanded: 840 } as const);

export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly widthClass: WidthClass;
}

export function widthClassOf(width: number): WidthClass {
  if (width >= breakpoint.expanded) return 'expanded';
  if (width >= breakpoint.medium) return 'medium';
  return 'compact';
}

const MeasuredContext = createContext<{ width: number; height: number } | null>(null);

export function useViewport(): Viewport {
  const window = useWindowDimensions();
  const measured = useContext(MeasuredContext);
  const { width, height } = measured ?? window;
  return { width, height, widthClass: widthClassOf(width) };
}

/** Sizes everything inside to this view's own box rather than the window. */
export function ViewportProvider({
  style,
  children,
}: {
  readonly style?: StyleProp<ViewStyle>;
  readonly children: ReactNode;
}): React.JSX.Element {
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  return (
    <View
      style={style}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setBox((current) =>
          current?.width === width && current.height === height ? current : { width, height },
        );
      }}
    >
      {/* Nothing renders until the box is known, so no screen lays out for the wrong width first. */}
      {box === null ? null : (
        <MeasuredContext.Provider value={box}>{children}</MeasuredContext.Provider>
      )}
    </View>
  );
}
