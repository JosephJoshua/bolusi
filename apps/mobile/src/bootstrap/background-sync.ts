// Trigger (d) for sync — api/01-sync §5 (d): one bounded background pass, best-effort. Registration
// and the bounded pass are shared with the media drain (background-task.ts); this file is the part
// only sync has: the task must exist BEFORE the app boots, but the loop it drives exists only after.
//
// WHY A HOST. `TaskManager.defineTask` has to run at module scope (index.ts) so that an OS launch
// straight into the background finds the task defined; a definition made later, after boot, is too
// late for that launch. The live `SyncClient` is built after boot, inside Root. The host bridges the
// two: the module-scope executor calls `runPass()`, and the client attaches itself once started. One
// loop, one DB connection: the pass drives the client the app already has, never a second one.
//
// WHAT A PASS DOES. A background-reason cycle (push, then pull) for at most the shared budget. At the
// budget the loop is asked to pause: the pull stops after its current batch commits, so a long first
// sync resumes from that batch on the next pass or the next foreground trigger.
//
// WHAT IT DOES NOT DO (stated, not glossed). If the client never attaches within `CLIENT_BOOT_WAIT_MS`
// the pass does nothing. That is the Android case where WorkManager wakes a killed app as a headless
// JS task: Root is never mounted, so there is no client. Booting a client headlessly needs one shared
// boot for both paths (or two DB connections would race); it is left as a follow-up.
import type { TimerPort } from '@bolusi/core';

import {
  registerBackgroundTask,
  runBoundedPass,
  type BackgroundRegistration,
  type BackgroundTaskPlatform,
} from './background-task.js';

/** The process-global task name. Defined once, at module scope in index.ts. */
export const SYNC_BACKGROUND_TASK = 'bolusi.sync';

/** How long a pass waits for the app to boot its client after an OS background launch. */
export const CLIENT_BOOT_WAIT_MS = 20_000;

/** What a pass drives — the live `SyncClient`'s background surface. */
export interface BackgroundSyncTarget {
  requestBackground(): void;
  pause(): void;
  settle(): Promise<void>;
}

export interface BackgroundSyncHost {
  /** The started client offers itself. Returns the detach for its `stop()`. */
  attach(target: BackgroundSyncTarget): () => void;
  /** The task executor: one bounded pass over the attached client, or nothing if none boots. */
  runPass(): Promise<void>;
}

export function createBackgroundSyncHost(timer: TimerPort): BackgroundSyncHost {
  let current: BackgroundSyncTarget | null = null;
  const waiting = new Set<(target: BackgroundSyncTarget | null) => void>();

  function waitForTarget(): Promise<BackgroundSyncTarget | null> {
    if (current !== null) return Promise.resolve(current);
    return new Promise((resolve) => {
      const cancel = timer.schedule(CLIENT_BOOT_WAIT_MS, () => {
        waiting.delete(done);
        resolve(null);
      });
      const done = (target: BackgroundSyncTarget | null): void => {
        cancel();
        resolve(target);
      };
      waiting.add(done);
    });
  }

  return {
    attach(target) {
      current = target;
      for (const done of waiting) done(target);
      waiting.clear();
      return () => {
        if (current === target) current = null;
      };
    },
    async runPass() {
      const target = await waitForTarget();
      if (target === null) return;
      await runBoundedPass({
        start: () => target.requestBackground(),
        settle: () => target.settle(),
        onBudgetSpent: () => target.pause(),

        timer,
      });
    },
  };
}

/** What the composition root hands the sync client so it can register trigger (d). */
export interface BackgroundSyncBinding {
  readonly platform: BackgroundTaskPlatform;
  readonly host: BackgroundSyncHost;
}

/** Register the sync task, reporting whether it took. The executor is the host's, whoever defined it. */
export function registerSyncTask(binding: BackgroundSyncBinding): Promise<BackgroundRegistration> {
  return registerBackgroundTask(binding.platform, SYNC_BACKGROUND_TASK, () =>
    binding.host.runPass(),
  );
}
