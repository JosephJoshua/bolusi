/**
 * System-window insets — platform MEASUREMENTS, deliberately not design tokens (task 205).
 *
 * These are not part of the styling vocabulary `tokens.ts` owns: they are the heights of OS chrome
 * that overlaps our window under edge-to-edge. They live in their own module so that distinction
 * stays visible, and so the one value has ONE definition (CLAUDE.md §2.8) — it was previously
 * defined in `apps/mobile/App.tsx` alone, which left every surface OUTSIDE the app shell (the
 * ConfirmSheet overlay) silently un-inset.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { Platform } from 'react-native';

/**
 * The height of the system bar at the bottom of the screen: Android's navigation bar (48 dp with
 * three buttons, about 24 dp with gesture navigation) or the iPhone home indicator.
 *
 * Its window sits z-above ours and eats any touch landing in it, so a control drawn under it is
 * visible but not tappable — a failure mode invisible to prop-level render tests (the control is
 * present and "visible" in the hierarchy) and to Maestro, which taps by bounds. It was caught only
 * on-device: `notes.editor.save` rendered at center y≈2284 on a 2400-tall AVD, inside the 3-button
 * nav-bar band, and the tap COMPLETED yet produced no onPress.
 *
 * The app's entry measures it per phone (`react-native-safe-area-context`) and passes it to
 * `BottomInsetProvider`. Until that measurement arrives, or where there is none (tests, web), Android
 * assumes the 3-button bar: it can only over-pad, never leave a control under the bar.
 *
 * Any surface that docks content to the bottom of the SCREEN must apply `useBottomInset()`.
 * Surfaces inside the app shell inherit it from the shell's own bottom padding; absolute overlays
 * that escape the shell (Sheet, ConfirmSheet, PhotoViewer) add it themselves.
 */
export const NAV_BAR_FALLBACK = Platform.OS === 'android' ? 48 : 0;

const BottomInsetContext = createContext<number>(NAV_BAR_FALLBACK);

/** The measured bottom inset; `null` or 0 before it arrives keeps the fallback. */
export function bottomInsetOf(measured: number | null | undefined): number {
  return typeof measured === 'number' && measured > 0 ? measured : NAV_BAR_FALLBACK;
}

export function BottomInsetProvider({
  measured,
  children,
}: {
  readonly measured: number | null | undefined;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <BottomInsetContext.Provider value={bottomInsetOf(measured)}>
      {children}
    </BottomInsetContext.Provider>
  );
}

export function useBottomInset(): number {
  return useContext(BottomInsetContext);
}
