/**
 * System-window insets — platform MEASUREMENTS, deliberately not design tokens (task 205).
 *
 * These are not part of the styling vocabulary `tokens.ts` owns: they are the heights of OS chrome
 * that overlaps our window under edge-to-edge. They live in their own module so that distinction
 * stays visible, and so the one value has ONE definition (CLAUDE.md §2.8) — it was previously
 * defined in `apps/mobile/App.tsx` alone, which left every surface OUTSIDE the app shell (the
 * ConfirmSheet overlay) silently un-inset.
 */
import { Platform } from 'react-native';

/**
 * The Android system navigation bar's height.
 *
 * Its window sits z-above ours and eats any touch landing in it, so a control drawn under it is
 * visible but not tappable — a failure mode invisible to prop-level render tests (the control is
 * present and "visible" in the hierarchy) and to Maestro, which taps by bounds. It was caught only
 * on-device: `notes.editor.save` rendered at center y≈2284 on a 2400-tall AVD, inside the 3-button
 * nav-bar band, and the tap COMPLETED yet produced no onPress.
 *
 * Why a constant rather than a measurement: there is no core-RN "exact occluding height" API for
 * the nav bar (`RNStatusBar.currentHeight` has no bottom twin, and under edge-to-edge `Dimensions`
 * screen == window so their difference is 0). `react-native-safe-area-context` — the only source of
 * the exact per-mode inset — is deliberately not a dependency. 48 dp is the Android 3-button
 * navigation-bar height: exact on the lane AVD and on the 3-button budget Android this app targets,
 * and it can only ever over-pad, never under-pad, so the control is always fully clear. Gesture-nav
 * devices have a smaller bottom inset, so there this leaves a small cosmetic gap above the gesture
 * pill — the same kind of accepted v0 trade-off as iOS being out of scope.
 *
 * Any surface that docks content to the bottom of the SCREEN must apply this. Surfaces inside the
 * app shell inherit it from the shell's own bottom padding; absolute overlays that escape the shell
 * (ConfirmSheet) must add it themselves.
 */
export const NAV_BAR_INSET = Platform.OS === 'android' ? 48 : 0;
