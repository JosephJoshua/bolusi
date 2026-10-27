// Phones are locked upright and tablets are left to turn, decided by the screen's short side so a
// phone that starts in landscape is still a phone.
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('expo-screen-orientation', () => ({
  OrientationLock: { PORTRAIT_UP: 2 },
  lockAsync: vi.fn(async () => undefined),
}));

import * as ScreenOrientation from 'expo-screen-orientation';
import { Dimensions } from 'react-native';

import { isPhoneSized, lockPhonesToPortrait } from './orientation.js';

beforeEach(() => vi.clearAllMocks());

describe('isPhoneSized', () => {
  test.each([
    [{ width: 360, height: 800 }, true],
    [{ width: 800, height: 360 }, true],
    [{ width: 599, height: 960 }, true],
    [{ width: 600, height: 960 }, false],
    [{ width: 1280, height: 800 }, false],
  ])('%o is a phone: %s', (screen, phone) => {
    expect(isPhoneSized(screen)).toBe(phone);
  });
});

describe('lockPhonesToPortrait', () => {
  test('locks a phone to portrait', async () => {
    vi.spyOn(Dimensions, 'get').mockReturnValue({
      width: 411,
      height: 914,
      scale: 2,
      fontScale: 1,
    });
    await lockPhonesToPortrait();
    expect(ScreenOrientation.lockAsync).toHaveBeenCalledWith(
      ScreenOrientation.OrientationLock.PORTRAIT_UP,
    );
  });

  test('leaves a tablet free to turn', async () => {
    vi.spyOn(Dimensions, 'get').mockReturnValue({
      width: 1280,
      height: 800,
      scale: 2,
      fontScale: 1,
    });
    await lockPhonesToPortrait();
    expect(ScreenOrientation.lockAsync).not.toHaveBeenCalled();
  });

  test('a refused lock does not stop the app', async () => {
    vi.spyOn(Dimensions, 'get').mockReturnValue({
      width: 360,
      height: 640,
      scale: 2,
      fontScale: 1,
    });
    vi.mocked(ScreenOrientation.lockAsync).mockRejectedValueOnce(new Error('unsupported'));
    await expect(lockPhonesToPortrait()).resolves.toBeUndefined();
  });
});
