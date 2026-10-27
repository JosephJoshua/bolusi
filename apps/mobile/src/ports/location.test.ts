// The watcher must never put a permission or "Location Accuracy" dialog in front of staff: no feature
// needs location yet, so it only watches a device that already allows it (first Android QA run).
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  requestForegroundPermissionsAsync: vi.fn(),
  getForegroundPermissionsAsync: vi.fn(),
  hasServicesEnabledAsync: vi.fn(),
  watchPositionAsync: vi.fn(async () => ({ remove: vi.fn() })),
}));

import * as Location from 'expo-location';

import { startLocationWatcher, stopLocationWatcher } from './location.js';

function permission(granted: boolean): Location.LocationPermissionResponse {
  return { granted, status: granted ? 'granted' : 'denied' } as Location.LocationPermissionResponse;
}

beforeEach(() => {
  stopLocationWatcher();
  vi.clearAllMocks();
});

describe('startLocationWatcher', () => {
  test('never asks for permission, even when it has not been granted', async () => {
    vi.mocked(Location.getForegroundPermissionsAsync).mockResolvedValue(permission(false));
    await startLocationWatcher();
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(Location.watchPositionAsync).not.toHaveBeenCalled();
  });

  test('does not watch while location services are off', async () => {
    vi.mocked(Location.getForegroundPermissionsAsync).mockResolvedValue(permission(true));
    vi.mocked(Location.hasServicesEnabledAsync).mockResolvedValue(false);
    await startLocationWatcher();
    expect(Location.watchPositionAsync).not.toHaveBeenCalled();
  });

  test('watches an allowed device without the accuracy settings dialog', async () => {
    vi.mocked(Location.getForegroundPermissionsAsync).mockResolvedValue(permission(true));
    vi.mocked(Location.hasServicesEnabledAsync).mockResolvedValue(true);
    await startLocationWatcher();
    expect(Location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(Location.watchPositionAsync).toHaveBeenCalledWith(
      expect.objectContaining({ mayShowUserSettingsDialog: false }),
      expect.any(Function),
    );
  });
});
