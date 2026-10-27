/**
 * The device `LocationPort` (08 §3.2) — expo-location, NON-BLOCKING by contract.
 *
 * Core's port comment is emphatic and this adapter is where that emphasis is either honoured or
 * betrayed: "It returns the best fix it already has, or `null`; it never waits on GPS… Synchronous
 * precisely so that 'never blocks' is structural."
 *
 * So this adapter NEVER calls `getCurrentPositionAsync`. It reads a fix that a background watcher has
 * already delivered, and returns `null` until one arrives. The distinction is the whole design:
 * `getBestFix()` is called inside the append path of EVERY command (05 §2.1 stamps `location` on the
 * envelope), and a cold GPS chip in a concrete-walled shop takes tens of seconds to fix. An adapter
 * that awaited one would make every note the shop writes wait on a satellite — turning the
 * offline-first promise (design-system §4 rule 1: "every action succeeds locally, instantly") into a
 * lie, on the exact hardware least able to afford it.
 *
 * `null` is therefore not a failure. It is the normal answer indoors, and 04 §5.1 step 4 says so:
 * "null never blocks".
 */
import * as Location from 'expo-location';

import type { LocationPort } from '@bolusi/core';

// The envelope's `Location` shape, taken from the PORT rather than imported from `@bolusi/schemas`.
// Mobile has no dependency on that package (08 §3.3 keeps the app's import edges narrow), and this
// adapter needs the type only to name its own return. Deriving it means the shape cannot drift from
// the port it must satisfy.
type OpLocation = NonNullable<ReturnType<LocationPort['getBestFix']>>;

/** A cached fix older than this is not worth stamping (the port's own "up to 60 s" guidance). */
const MAX_FIX_AGE_MS = 60_000;

let lastFix: Location.LocationObject | null = null;
let watcher: Location.LocationSubscription | null = null;

/**
 * Start the background watcher, but only on a device that already allows it. Safe to call twice.
 *
 * It NEVER asks. No feature in the app needs location yet: it is telemetry on an envelope (PRD-009
 * FR-802), and a `null` fix is a supported state. Asking for it on every cold start, with no
 * explanation, put Android's permission dialog and then Google's "Location Accuracy" dialog in
 * front of a cashier who had done nothing location-related (first Android QA run, 2026-10-26).
 * The feature that needs it (attendance check-in) asks there, in context, when it is built.
 *
 * So: permission already granted AND location services already on, or nothing. And the watch is
 * started with `mayShowUserSettingsDialog: false`, so even a granted device with Wi-Fi scanning
 * off is never shown the accuracy dialog; it just gets coarser fixes.
 */
export async function startLocationWatcher(): Promise<void> {
  if (watcher !== null) return;
  const { granted } = await Location.getForegroundPermissionsAsync();
  if (!granted) return;
  if (!(await Location.hasServicesEnabledAsync())) return;
  watcher = await Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: MAX_FIX_AGE_MS,
      distanceInterval: 50,
      mayShowUserSettingsDialog: false,
    },
    (fix) => {
      lastFix = fix;
    },
  );
}

/** Stop the watcher (app teardown). */
export function stopLocationWatcher(): void {
  watcher?.remove();
  watcher = null;
}

export const expoLocationPort: LocationPort = {
  getBestFix(): OpLocation | null {
    if (lastFix === null) return null;
    // A stale fix is worse than none: stamping an hour-old position onto an op asserts something
    // false about where the work happened, and the envelope is signed and immutable (05 §1).
    if (Date.now() - lastFix.timestamp > MAX_FIX_AGE_MS) return null;
    return {
      lat: lastFix.coords.latitude,
      lng: lastFix.coords.longitude,
      accuracyMeters: lastFix.coords.accuracy ?? 0,
    };
  },
};
