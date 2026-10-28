// A headless pass: the client a background task builds when no Root is running.
//
// When Android's WorkManager wakes a killed app, the bundle runs and the task fires, but Root never
// mounts, so nothing opens the database. A background pass therefore boots for itself. If the user
// then opens the app, the activity attaches to the SAME JS runtime (expo-modules-core's
// RNHeadlessAppLoader starts the application's own ReactHost), so Root must reuse that boot rather
// than open a second connection to the same file. Both go through `bootOncePerRealm` (bootstrap.ts).
import type { BackgroundPassTarget, HeadlessPass } from './background-task.js';

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
