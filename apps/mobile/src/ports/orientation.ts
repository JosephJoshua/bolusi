/**
 * Phones stay upright; tablets turn.
 *
 * The phone layouts are built for portrait, and a phone held sideways at the counter has room for
 * little more than the keyboard. A tablet has room either way, and in landscape the servisan board
 * sits beside the open ticket (RepairHome). So the app allows every orientation in its config and
 * locks a phone to portrait once it starts. Android 16 ignores an orientation lock on a large screen
 * anyway, which is one more reason the tablet layouts must work both ways.
 */
import { breakpoint } from '@bolusi/ui';
import * as ScreenOrientation from 'expo-screen-orientation';
import { Dimensions } from 'react-native';

/** A phone, by its short side: anything narrower than a small tablet held upright. */
export function isPhoneSized(screen: { readonly width: number; readonly height: number }): boolean {
  return Math.min(screen.width, screen.height) < breakpoint.medium;
}

export async function lockPhonesToPortrait(): Promise<void> {
  if (!isPhoneSized(Dimensions.get('screen'))) return;
  try {
    await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
  } catch {
    // The phone keeps turning; every screen still lays out at its width, just less comfortably.
  }
}
