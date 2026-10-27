// Phones are locked upright and tablets are left to turn, decided by the screen's short side so a
// phone that starts in landscape is still a phone, and decided again when a foldable opens or closes.
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('expo-screen-orientation', () => ({
  OrientationLock: { PORTRAIT_UP: 2 },
  lockAsync: vi.fn(async () => undefined),
  unlockAsync: vi.fn(async () => undefined),
}));

import * as ScreenOrientation from 'expo-screen-orientation';
import { Dimensions } from 'react-native';

import { isPhoneSized, lockPhonesToPortrait } from './orientation.js';

type Screen = { width: number; height: number; scale: number; fontScale: number };
const screen = (width: number, height: number): Screen => ({
  width,
  height,
  scale: 2,
  fontScale: 1,
});

let changeListener: ((event: { window: Screen; screen: Screen }) => void) | null = null;
beforeEach(() => {
  vi.clearAllMocks();
  changeListener = null;
  vi.spyOn(Dimensions, 'addEventListener').mockImplementation((_type, listener) => {
    changeListener = listener as typeof changeListener;
    return { remove: vi.fn() };
  });
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('isPhoneSized', () => {
  test.each([
    [{ width: 360, height: 800 }, true],
    [{ width: 800, height: 360 }, true],
    [{ width: 599, height: 960 }, true],
    [{ width: 600, height: 960 }, false],
    [{ width: 1280, height: 800 }, false],
  ])('%o is a phone: %s', (size, phone) => {
    expect(isPhoneSized(size)).toBe(phone);
  });
});

describe('lockPhonesToPortrait', () => {
  test('locks a phone to portrait', async () => {
    vi.spyOn(Dimensions, 'get').mockReturnValue(screen(411, 914));
    lockPhonesToPortrait();
    await flush();
    expect(ScreenOrientation.lockAsync).toHaveBeenCalledWith(
      ScreenOrientation.OrientationLock.PORTRAIT_UP,
    );
  });

  test('leaves a tablet free to turn', async () => {
    vi.spyOn(Dimensions, 'get').mockReturnValue(screen(1280, 800));
    lockPhonesToPortrait();
    await flush();
    expect(ScreenOrientation.lockAsync).not.toHaveBeenCalled();
  });

  test('a foldable opened to tablet size is let go, and locked again when folded', async () => {
    vi.spyOn(Dimensions, 'get').mockReturnValue(screen(380, 850));
    lockPhonesToPortrait();
    await flush();
    expect(ScreenOrientation.lockAsync).toHaveBeenCalledTimes(1);

    changeListener?.({ window: screen(700, 840), screen: screen(700, 840) });
    await flush();
    expect(ScreenOrientation.unlockAsync).toHaveBeenCalledTimes(1);

    // Turning the open tablet is not a new decision.
    changeListener?.({ window: screen(840, 700), screen: screen(840, 700) });
    await flush();
    expect(ScreenOrientation.unlockAsync).toHaveBeenCalledTimes(1);

    changeListener?.({ window: screen(380, 850), screen: screen(380, 850) });
    await flush();
    expect(ScreenOrientation.lockAsync).toHaveBeenCalledTimes(2);
  });

  test('a refused lock does not stop the app', async () => {
    vi.spyOn(Dimensions, 'get').mockReturnValue(screen(360, 640));
    vi.mocked(ScreenOrientation.lockAsync).mockRejectedValueOnce(new Error('unsupported'));
    expect(() => lockPhonesToPortrait()).not.toThrow();
    await flush();
  });
});
