// One boot per process, shared by the UI and by background tasks.
//
// When Android's WorkManager wakes a killed app, the bundle runs and the task fires, but Root never
// mounts, so nothing opens the database. A background pass therefore boots for itself. If the user
// then opens the app, the activity attaches to the SAME JS runtime (expo-modules-core's
// RNHeadlessAppLoader starts the application's own ReactHost), so Root must reuse that boot rather
// than open a second connection to the same file. `shareBoot` makes both callers get one boot.
import type { BackgroundPassTarget, HeadlessPass } from './background-task.js';

/**
 * Run `boot` at most once per process. Every caller shares that boot's connection and gets it
 * through `refresh`, which re-reads whatever can change after boot (a live enrollment writes the
 * device id), so a later caller never sees a stale snapshot. A failed boot is forgotten, so the next
 * caller (the UI, after a background boot failed on a locked iPhone) tries again rather than
 * inheriting the failure. A caller that joined someone else's failed boot retries once with its own
 * `arg`, so the UI still gets its self-healing boot after a background boot failed.
 */
export function shareBoot<T, A = void>(
  boot: (arg: A) => Promise<T>,
  refresh: (booted: T) => Promise<T> = (booted) => Promise.resolve(booted),
): (arg: A) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  const run = async (arg: A, mayRetry: boolean): Promise<T> => {
    // `arg` reaches `boot` only when this call is the one that boots; a later caller joins the boot
    // in flight whatever it passes (a background task joining the UI's boot, or the reverse).
    const joined = inFlight !== null;
    inFlight ??= boot(arg).catch((error: unknown) => {
      inFlight = null;
      throw error;
    });
    let booted: T;
    try {
      booted = await inFlight;
    } catch (error) {
      // A joined boot that failed was another caller's attempt, made its way (a background boot
      // does not self-heal). Try once more our own way before giving up.
      if (joined && mayRetry) return run(arg, false);
      throw error;
    }
    return refresh(booted);
  };
  return (arg) => run(arg, true);
}

/** A client that can run one headless pass. Both the sync and the media client are one. */
export interface HeadlessClient extends BackgroundPassTarget {
  startForBackgroundPass(): Promise<void>;
  stop(): void;
}

/**
 * The host's `startHeadless` over the shared boot: boot (or join the boot in flight), build a client
 * without trigger (d) of its own, and start it for one pass. `null` when `build` says there is
 * nothing to drive, which is an unenrolled device.
 */
export function headlessPass<App>(
  boot: () => Promise<App>,
  build: (app: App) => HeadlessClient | null,
): () => Promise<HeadlessPass | null> {
  return async () => {
    const client = build(await boot());
    if (client === null) return null;
    try {
      await client.startForBackgroundPass();
    } catch (error) {
      client.stop();
      throw error;
    }
    return { target: client, stop: () => client.stop() };
  };
}
