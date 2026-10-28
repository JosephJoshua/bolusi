// The `expo-background-task` + `expo-task-manager` native binding, shared by every background task
// (media drain, sync). Imported only from native binding sites; the logic lives behind
// `BackgroundTaskPlatform` in bootstrap/background-task.ts and runs in the Node test lane.
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import type { BackgroundTaskPlatform } from '@bolusi/device/bootstrap/background-task';

/**
 * The `expo-background-task` + `expo-task-manager` binding.
 *
 * `defineTask`'s executor is typed `(body) => Promise<any>` upstream; ours takes no body and the
 * wrapper discards it. The `void` return is deliberate: `BackgroundTaskResult` exists (Success = 1,
 * Failed = 2) and returning `Failed` would be the honest thing IF a bounded drain pass could fail —
 * it cannot, by design. The drain loop never throws to its caller (drain.ts); a pass that uploads
 * nothing because the network is down is a NORMAL pass, and reporting `Failed` for it would teach
 * WorkManager to back this task off for a condition that is not an error. So the executor resolves
 * either way and the real failure reporting stays where 06 §8 puts it: `media_items.last_error_code`
 * and the surfacing port.
 */
export const expoBackgroundTaskPlatform: BackgroundTaskPlatform = {
  defineTask(name, executor) {
    // Guarded because `defineTask` is a PROCESS-GLOBAL registration and this function is reachable
    // from any composition. Defining twice is not idempotent upstream — it replaces the executor —
    // and a second definition racing the first is the collision `bootstrap/triggers.ts` names when
    // it explains why trigger (d) was left to this task rather than built in two places.
    if (TaskManager.isTaskDefined(name)) return;
    TaskManager.defineTask(name, async () => {
      await executor();
    });
  },
  getStatusAsync: () => BackgroundTask.getStatusAsync(),
  registerTaskAsync: (name, options) => BackgroundTask.registerTaskAsync(name, options),
  isTaskRegisteredAsync: (name) => TaskManager.isTaskRegisteredAsync(name),
};
