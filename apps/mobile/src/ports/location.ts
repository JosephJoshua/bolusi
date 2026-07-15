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
 * Start the background watcher. Safe to call twice; a denied permission simply leaves every fix
 * `null`, which is a supported state and never an error the user is shown — location is telemetry on
 * an envelope (PRD-009 FR-802), not a feature anyone asked for.
 */
export async function startLocationWatcher(): Promise<void> {
  if (watcher !== null) return;
  const { granted } = await Location.requestForegroundPermissionsAsync();
  if (!granted) return;
  watcher = await Location.watchPositionAsync(
    { accuracy: Location.Accuracy.Balanced, timeInterval: MAX_FIX_AGE_MS, distanceInterval: 50 },
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
