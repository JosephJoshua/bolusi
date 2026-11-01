/**
 * Keeping a focused field in sight above the on-screen keyboard.
 *
 * Android draws apps edge to edge (Expo SDK 54+), so the window no longer shrinks for the
 * keyboard, and iOS never did: the keyboard simply covers the bottom of the screen. `AppShell`
 * therefore lifts its content and bottom action above the keyboard (`useKeyboardLift`), and a
 * scrollable shell scrolls the focused field into what is left of the screen, again whenever that
 * space changes (the keyboard opening after the focus, or switching to the emoji keyboard).
 *
 * The lift is measured in window coordinates on purpose. React Native's KeyboardAvoidingView
 * compares the keyboard's screen position with its own frame relative to its parent, so under a
 * status bar inset it came up short by that inset: on an Android 16 emulator the bottom action sat
 * under the keyboard's top edge with only a sliver showing.
 *
 * Fields ask for it with `useRevealOnFocus`. Most only need to be seen ('into-view'). A field whose
 * suggestions open below it (the phone model at intake) asks to go to the top ('to-top'), so the
 * suggestions get the room between it and the keyboard.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  Keyboard,
  Platform,
  type KeyboardEvent,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
  type TextInput,
  type View,
} from 'react-native';

import { space } from '../tokens.js';

export type RevealMode = 'into-view' | 'to-top';

/** A focused field: its input, and the box to bring into sight (the input with its label). */
interface Focused {
  readonly input: TextInput;
  readonly anchor: View | TextInput;
  readonly mode: RevealMode;
}

interface RevealPort {
  /** A field was focused: scroll it into sight now, and again when the visible area changes. */
  focused(field: Focused): void;
  /** Something just appeared (a stepper under a picked row): scroll it into sight once. */
  show(anchor: View): void;
}

const RevealContext = createContext<RevealPort | null>(null);

/** Where a focused field should sit: `space.lg` clear of the top or bottom edge. */
const MARGIN = space.lg;

/**
 * How far the bottom of `ref`'s view sits under the keyboard's top edge, in dp: the padding that
 * lifts the shell's content and bottom action clear of it. 0 while the keyboard is down, and on
 * the web, which has no keyboard events.
 */
export function useKeyboardLift(): { readonly ref: RefObject<View | null>; readonly lift: number } {
  const ref = useRef<View | null>(null);
  const [lift, setLift] = useState(0);
  useEffect(() => {
    // iOS announces the keyboard before it moves, so the lift rides along; Android only after.
    const [show, hide] =
      Platform.OS === 'ios'
        ? (['keyboardWillShow', 'keyboardWillHide'] as const)
        : (['keyboardDidShow', 'keyboardDidHide'] as const);
    const shown = Keyboard.addListener(show, (event: KeyboardEvent) => {
      const keyboardTop = event.endCoordinates.screenY;
      ref.current?.measureInWindow((_x, y, _width, height) => {
        setLift(Math.max(0, Math.round(y + height - keyboardTop)));
      });
    });
    const hidden = Keyboard.addListener(hide, () => setLift(0));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  return { ref, lift };
}

/** The scrolling half, owned by `AppShell`'s ScrollView. */
export function useRevealingScroll(): {
  readonly port: RevealPort;
  readonly scrollRef: (view: ScrollView | null) => void;
  readonly contentRef: RefObject<View | null>;
  readonly onLayout: (event: LayoutChangeEvent) => void;
  readonly onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
} {
  const scroll = useRef<ScrollView | null>(null);
  const contentRef = useRef<View | null>(null);
  const viewport = useRef({ height: 0, offset: 0 });
  const last = useRef<Focused | null>(null);

  const reveal = useCallback(({ anchor, mode }: Pick<Focused, 'anchor' | 'mode'>) => {
    const content = contentRef.current;
    if (content === null || viewport.current.height === 0) return;
    anchor.measureLayout(
      content,
      (_x, y, _width, height) => {
        const { height: visible, offset } = viewport.current;
        let target: number | null = null;
        if (mode === 'to-top' || y - MARGIN < offset) target = y - MARGIN;
        else if (y + height + MARGIN > offset + visible) target = y + height + MARGIN - visible;
        if (target !== null) scroll.current?.scrollTo({ y: Math.max(0, target), animated: true });
      },
      () => undefined,
    );
  }, []);

  const port = useMemo<RevealPort>(
    () => ({
      focused(field) {
        last.current = field;
        reveal(field);
      },
      show(anchor) {
        reveal({ anchor, mode: 'into-view' });
      },
    }),
    [reveal],
  );

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const height = event.nativeEvent.layout.height;
      if (height === viewport.current.height) return;
      viewport.current.height = height;
      // The keyboard opened (or changed) after the focus: bring the field back into sight.
      const focused = last.current;
      if (focused !== null && focused.input.isFocused()) reveal(focused);
    },
    [reveal],
  );

  // A new ScrollView (AppShell remounts it per `scrollKey`) starts at the top, whatever the last
  // one was scrolled to.
  const scrollRef = useCallback((view: ScrollView | null) => {
    if (view !== scroll.current) viewport.current.offset = 0;
    scroll.current = view;
  }, []);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    viewport.current.offset = event.nativeEvent.contentOffset.y;
  }, []);

  return { port, scrollRef, contentRef, onLayout, onScroll };
}

export function RevealProvider({
  port,
  children,
}: {
  readonly port: RevealPort | null;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return <RevealContext.Provider value={port}>{children}</RevealContext.Provider>;
}

/**
 * For a field: a ref for the input, an optional ref for the box to keep in sight (the input with
 * its label; the input alone when absent), and an `onFocus` that reveals it. Outside a scrollable
 * shell there is nothing to scroll and the focus handler does nothing.
 */
export function useRevealOnFocus(mode: RevealMode = 'into-view'): {
  readonly ref: RefObject<TextInput | null>;
  readonly anchorRef: RefObject<View | null>;
  readonly onFocus: () => void;
} {
  const port = useContext(RevealContext);
  const ref = useRef<TextInput | null>(null);
  const anchorRef = useRef<View | null>(null);
  const onFocus = useCallback(() => {
    if (port === null) return;
    const reveal = (): void => {
      const input = ref.current;
      if (input !== null) port.focused({ input, anchor: anchorRef.current ?? input, mode });
    };
    // An `autoFocus` field fires its focus while mounting, before its ref is attached.
    if (ref.current === null) setTimeout(reveal, 0);
    else reveal();
  }, [port, mode]);
  return { ref, anchorRef, onFocus };
}

/**
 * For something that appears under the user's finger, such as the quantity under a picked row: a
 * ref for its box and an `onLayout` that scrolls it into sight the first time it is laid out, so
 * it never opens behind the bottom action. Outside a scrollable shell it does nothing.
 */
export function useRevealOnMount(): {
  readonly anchorRef: RefObject<View | null>;
  readonly onLayout: () => void;
} {
  const port = useContext(RevealContext);
  const anchorRef = useRef<View | null>(null);
  const shown = useRef(false);
  const onLayout = useCallback(() => {
    if (port === null || shown.current || anchorRef.current === null) return;
    shown.current = true;
    port.show(anchorRef.current);
  }, [port]);
  return { anchorRef, onLayout };
}
