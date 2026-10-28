/**
 * Phones stay upright; tablets turn.
 *
 * The phone layouts are built for portrait, and a phone held sideways at the counter has room for
 * little more than the keyboard. A tablet has room either way, and in landscape the servisan board
 * sits beside the open ticket (RepairHome). So the app allows every orientation in its config and
 * locks a phone to portrait once it starts. Android 16 ignores an orientation lock on a large screen
 * anyway, which is one more reason the tablet layouts must work both ways.
 *
 * Decided again whenever the screen changes size, so a foldable is a phone folded and a tablet open.
 */
import { widthClassOf } from '@bolusi/ui';
import * as ScreenOrientation from 'expo-screen-orientation';
import { Dimensions } from 'react-native';

/** A phone, by its short side: anything narrower than a small tablet held upright. */
export function isPhoneSized(screen: { readonly width: number; readonly height: number }): boolean {
  return widthClassOf(Math.min(screen.width, screen.height)) === 'compact';
}

async function applyFor(screen: {
  readonly width: number;
  readonly height: number;
}): Promise<void> {
  try {
    if (isPhoneSized(screen)) {
      await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    } else {
      await ScreenOrientation.unlockAsync();
    }
  } catch {
    // The phone keeps turning; every screen still lays out at its width, just less comfortably.
  }
}

/** Lock a phone upright now and follow the screen if it changes (a foldable opened or closed). */
export function lockPhonesToPortrait(): void {
  let phone = isPhoneSized(Dimensions.get('screen'));
  void applyFor(Dimensions.get('screen'));
  Dimensions.addEventListener('change', ({ screen }) => {
    if (isPhoneSized(screen) === phone) return;
    phone = isPhoneSized(screen);
    void applyFor(screen);
  });
}
