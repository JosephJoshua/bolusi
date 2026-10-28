// Trigger (d) for sync — api/01-sync §5 (d): one bounded background pass, best-effort. The host,
// registration and bounded pass are shared with the media drain (background-task.ts). A sync pass
// is a background-reason cycle (push, then pull); at the budget the loop pauses after its current
// pull batch commits, so a long first sync resumes from that batch on the next pass.
import { registerHostTask, type BackgroundBinding } from './background-task.js';
import type { BackgroundRegistration } from './background-task.js';

/** The process-global task name. Defined once, at module scope in index.ts. */
export const SYNC_BACKGROUND_TASK = 'bolusi.sync';

export function registerSyncTask(binding: BackgroundBinding): Promise<BackgroundRegistration> {
  return registerHostTask(binding, SYNC_BACKGROUND_TASK);
}
